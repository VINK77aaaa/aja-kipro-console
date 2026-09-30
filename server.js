// AJA Ki Pro 中文控制台 —— 本机代理服务（Node 零依赖）
//
// 作用：浏览器禁止跨域直连设备，本机服务代为转发到 Ki Pro 私有 HTTP API。
//      设备上的英文原版页面完全不受影响，两者可以同时用。
//
// 启动：node server.js
//
// 环境变量：
//   AJA_DEVICES      设备列表，逗号分隔。支持「名称@IP」或只写 IP（自动命名 AJA1/AJA2…）
//                    例：AJA_DEVICES="A机@10.10.12.51,B机@10.10.12.52,C机@10.10.12.53"
//   AJA_DEVICE_IP    单台设备 IP（旧配置，仍兼容）
//   AJA_DEVICE_PORT  设备 HTTP 端口（默认 80）
//   AJA_PANEL_PORT   本面板端口（默认 8321）
//   AJA_STOP_LOCK    停止锁。默认 1（锁死）：「停止」「全部停止」在面板上点不动，
//                    手搓请求也会被服务端 403 拒绝。设为 0 可临时解禁。
//
// 设备列表的读取优先级：AJA_DEVICES 环境变量 > 同目录 devices.txt > AJA_DEVICE_IP > 默认单台。
// 多机（2~8 台）推荐直接编辑同目录的 devices.txt，一行一台，见该文件内的说明；
// 也可以在面板上点「＋ 添加设备」按 IP 添加（只读探测通过后追加写 devices.txt 并热重载，无需重启）。
//
// 接口一览：
//   GET  /api/devices          设备清单 + 在线探测
//   POST /api/devices/add      ?name=&ip=            添加设备（IPv4 校验 → 只读探测 → 追加 devices.txt）
//   POST /api/devices/remove   ?target=<id|名称|IP>  移除设备（删除 devices.txt 对应行）
//   POST /api/gang             ?cmd=record|stop&devs= 软 Gang：向多台设备群发走带命令（verify=0）
//   GET  /api/all|get|options|set|clips|health       原有单机接口（带 ?dev= 指定设备）

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEVICE_PORT = Number(process.env.AJA_DEVICE_PORT || 80);
const PANEL_PORT = Number(process.env.AJA_PANEL_PORT || 8321);
const DEVICE_TIMEOUT_MS = Number(process.env.AJA_DEVICE_TIMEOUT_MS || 8000);
const PROBE_TIMEOUT_MS = 2500;
const RETRY_DELAY_MS = 120;
const MAX_VALUE_LEN = 256;

// 停止锁：给「停止」「全部停止」加服务端闸门。
// 锁死时：面板按钮置灰点不动 + 服务端对 TransportCommand=4 / gang cmd=stop 一律 403。
// 需要临时解禁：用 AJA_STOP_LOCK=0 启动服务（不必改代码）。
const STOP_LOCK = process.env.AJA_STOP_LOCK !== '0';

const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const DEVICES_FILE = path.join(__dirname, 'devices.txt');
const STARTED_AT = Date.now();

// ==================== 设备列表 ====================
// 优先级：环境变量 AJA_DEVICES > 同目录 devices.txt > AJA_DEVICE_IP > 默认单台
function readDevicesConfig() {
  const env = (process.env.AJA_DEVICES || '').trim();
  if (env) return env;
  try {
    const txt = fs.readFileSync(DEVICES_FILE, 'utf8');
    const line = txt
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
      .join(',');
    if (line) return line;
  } catch {
    // 没有 devices.txt 就走单台旧配置
  }
  return (process.env.AJA_DEVICE_IP || '10.10.12.53').trim();
}

function parseDevices() {
  const raw = readDevicesConfig();
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const m = entry.match(/^([^@]+)@(.+)$/);
      const name = m ? m[1].trim() : '';
      const ip = (m ? m[2] : entry).trim();
      return { id: String(i), name: name || 'AJA' + (i + 1), ip };
    });
}

let DEVICES = parseDevices();

// 改完 devices.txt 后热重载设备列表（无需重启面板）
function reloadDevices() {
  DEVICES = parseDevices();
  return DEVICES;
}

// 设备列表当前来自哪里：环境变量 > devices.txt > 单台环境变量 > 默认
function devicesSource() {
  if ((process.env.AJA_DEVICES || '').trim()) return 'env';
  if (readDevicesFileLines().some((l) => l.trim() && !l.trim().startsWith('#'))) return 'file';
  if ((process.env.AJA_DEVICE_IP || '').trim()) return 'env-ip';
  return 'default';
}

// devices.txt 原始行（保留注释与顺序），读不到返回 []
function readDevicesFileLines() {
  try {
    return fs.readFileSync(DEVICES_FILE, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

// 原子写（先写 .tmp 再改名，避免半截文件）
function writeFileAtomic(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// 严格 IPv4 校验（4 段 0-255）
function isValidIPv4(s) {
  const m = String(s || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((x) => {
    if (x.length > 1 && x.startsWith('0')) return false; // 拒绝 01.02.03.04 这类写法
    const n = Number(x);
    return n >= 0 && n <= 255;
  });
}

// 名称合法性：不能含分隔符/注释符/控制字符
function isValidDeviceName(s) {
  if (typeof s !== 'string') return false;
  if (s.length > 32) return false;
  return !/[@,#\r\n\t]/.test(s) && !/[\u0000-\u001f\u007f]/.test(s);
}

// 按 id 或名称解析设备；不传则用第一台（保持旧行为）
function resolveDevice(sel) {
  if (sel === undefined || sel === null || sel === '') return DEVICES[0] || null;
  const s = String(sel).trim().toLowerCase();
  return DEVICES.find((d) => d.id === s || d.name.toLowerCase() === s || d.ip === s) || null;
}

// —— 状态页轮询的参数集合（一次请求批量取回） ——
const BATCH_PARAMS = [
  // 头部设备信息
  'eParamID_ProductID',
  'eParamID_SWVersion',
  'eParamID_SysName',
  // 状态区
  'eParamID_TransportState',
  'eParamID_DetectInputFormat',
  'eParamID_RecordFormat',
  'eParamID_DisplayTimecode',
  'eParamID_CurrentClip',
  'eParamID_SelectedSlot',
  'eParamID_DetectMediaFormat',
  'eParamID_CurrentMediaAvailable',
  'eParamID_VolumeName',
  // 配置区（当前值）
  'eParamID_MediaState',
  'eParamID_EncodeChannels',
  'eParamID_ChannelsToRecord',
  'eParamID_FileFormat',
  'eParamID_EncodeType_MultiChnl_Ch1',
  'eParamID_EncodeType_MultiChnl_Ch2',
  'eParamID_EncodeType_MultiChnl_Ch3',
  'eParamID_EncodeType_MultiChnl_Ch4',
  'eParamID_AudioChannels',
  'eParamID_AudioInSelectCh1',
  'eParamID_AudioInSelectCh2',
  'eParamID_AudioInSelectCh3',
  'eParamID_AudioInSelectCh4',
  'eParamID_AudioEncodeChannelFocus',
  'eParamID_PlayMedia',
  'eParamID_SDIMonitorChannel',
  'eParamID_HDMIOutChannel',
  // 拍摄前命名（P1）
  'eParamID_UseCustomClipName',
  'eParamID_CustomClipName',
  'eParamID_CustomTake',
  'eParamID_ClipNumber',
  'eParamID_Take',
  'eParamID_ClipAppend',
  'eParamID_AlphaAppend',
  // 介质操作进度
  'eParamID_Progress',
  'eParamID_MediaLoading',
];

// ==================== 设备 HTTP ====================
function deviceGetOnce(device, pathAndQuery, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: device.ip,
        port: DEVICE_PORT,
        path: pathAndQuery,
        method: 'GET',
        timeout: timeoutMs || DEVICE_TIMEOUT_MS,
        headers: { Connection: 'close' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('device timeout')));
    req.on('error', reject);
    req.end();
  });
}

// 网络类错误重试一次（设备偶发抽风）；HTTP 层返回码不做重试
async function deviceGet(device, pathAndQuery) {
  try {
    return await deviceGetOnce(device, pathAndQuery);
  } catch (err) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return deviceGetOnce(device, pathAndQuery);
  }
}

// /config?action=get 返回 {"paramid":..,"name":..,"value":..,"value_name":..}
function parseParamJson(body) {
  try {
    const o = JSON.parse(body);
    if (!o || !o.name) return null;
    return { param: o.name, value: o.value, value_name: o.value_name || '' };
  } catch {
    return null;
  }
}

// /options?eParamID_xxx 返回宽松 JS 字面量（键名无引号），按条目正则解析
function parseOptions(body) {
  const items = [];
  const re = /\{\s*value\s*:\s*"([^"]*)"\s*,\s*text\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(body))) items.push({ value: m[1], text: m[2] });
  return items;
}

async function mapWithConcurrency(list, limit, fn) {
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i += limit) {
    const slice = list.slice(i, i + limit);
    const part = await Promise.all(
      slice.map((item, j) => fn(item, i + j).catch((err) => ({ error: String(err.message || err) }))),
    );
    part.forEach((v, j) => (out[i + j] = v));
  }
  return out;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function validParamName(name) {
  return /^eParamID_[A-Za-z0-9_]+$/.test(name);
}

// 值白名单：放行可打印字符与中文（含 , + / ( ) 等），只挡控制字符与超长
function validValue(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_VALUE_LEN) return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
}

async function probeDevice(device) {
  try {
    const r = await deviceGetOnce(device, '/config?action=get&paramid=eParamID_ProductID', PROBE_TIMEOUT_MS);
    const parsed = parseParamJson(r.body);
    return { online: !!parsed, product: parsed ? parsed.value_name || parsed.value : null };
  } catch {
    return { online: false, product: null };
  }
}

// 添加设备用的探测：只读 GET 一次 eParamID_ProductID，返回可读的失败原因
// 注意：这里绝不向设备写任何参数。
async function probeForAdd(ip) {
  try {
    const r = await deviceGetOnce(
      { ip },
      '/config?action=get&paramid=eParamID_ProductID',
      PROBE_TIMEOUT_MS,
    );
    const parsed = parseParamJson(r.body);
    if (!parsed) {
      return {
        ok: false,
        reason: `该地址有响应，但没有返回 eParamID_ProductID（HTTP ${r.status}）—— 看起来不是 AJA Ki Pro 设备`,
      };
    }
    return { ok: true, product: parsed.value_name || parsed.value, status: r.status };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/timeout/i.test(msg)) {
      return { ok: false, reason: '连接超时 —— IP 不可达，或设备不在同一网段 / 被防火墙拦截' };
    }
    return { ok: false, reason: `无法连接（${msg}）` };
  }
}

// ==================== 告警（Alarms）====================
// 设备的告警参数是 **protobuf 二进制**，不是普通 JSON —— 通用读取器读不懂，所以这里单独解码。
// schema 来自设备自带（可直接 GET http://<设备IP>/alarm.proto 与 /error.proto）：
//   message Alarm {
//     enum State    { NORMAL = 0; ALARM = 1; }
//     enum Severity { WARNING = 0; ERROR = 1; FATAL = 2; }
//     required State    state    = 1;   // varint
//     optional Severity severity = 2;   // varint（静态属性，NORMAL 时也存在）
//     repeated Error    error    = 3;   // { string text = 1; string short_text = 2; }
//   }
// 读取：GET /config?action=get&paramid=eParamID_XXX_Alarm → value 是 base64 protobuf。
// 本模块**只读**，不向设备写任何参数。

const SEVERITY_CN = ['警告', '错误', '严重'];
const SEVERITY_KEY = ['WARNING', 'ERROR', 'FATAL'];

// param_id → [中文名, 中文说明]。名称/说明来自设备英文原文，逐条对照翻译。
// 设备在告警抬升时可能追加更详细的 error 文案（例如 No SDI input detected），
// 那些原文会一并展示，不丢信息。
const ALARM_CN = {
  // ---- 严重 FATAL ----
  eParamID_Fan_Stopped_Alarm: ['风扇停转', '设备散热风扇停止工作，请立即停机检查'],
  // ---- 错误 ERROR ----
  eParamID_2_Channel_Format_Alarm: ['声道格式冲突', '2.1 音频输入与 2.3 音频通道设置互相冲突'],
  eParamID_AV_Mismatch_Alarm: ['音视频不匹配', '音频与视频格式不匹配'],
  eParamID_Media_Damaged_Alarm: ['介质损坏', '请备份数据后重新格式化介质'],
  eParamID_Change_Encode_Mode_Alarm: ['请更改编码模式', '当前设置下该编码模式不可用'],
  eParamID_HQ_Not_Supported_Alarm: ['请更改编码类型', '当前输入不支持所选编码类型'],
  eParamID_BitRate_Not_Compatible_Alarm: ['请更改编码类型', '码率与当前设置不兼容'],
  eParamID_Genlock_Mismatch_Alarm: ['同步信号不匹配', 'Genlock 参考信号与输入不匹配'],
  eParamID_Invalid_Selection_Alarm: ['选择无效', '当前参数组合无效'],
  eParamID_MXF_Record_Inhibited_Alarm: ['选择无效', '当前选择下 MXF 无法录制'],
  eParamID_Media_Full_Alarm: ['介质已满', '存储介质空间已满'],
  eParamID_Name_In_Use_Alarm: ['名称已被占用', '设备名称与其他设备冲突'],
  eParamID_No_Media_Installed_Alarm: ['未安装介质', '未检测到存储介质'],
  eParamID_No_Rollover_Alarm: ['无法接力录制', '没有可接力的第二块介质'],
  eParamID_Non_VFR_Format_Alarm: ['非 VFR 格式', '当前为固定帧率格式'],
  eParamID_Record_Format_Alarm: ['录制格式问题', '当前录制格式不可用'],
  eParamID_SDI_VFR_Mismatch_Alarm: ['SDI VFR 不匹配', 'SDI 输入与 VFR 设置不匹配'],
  eParamID_Storage_Removed_Alarm: ['介质已拔出', '存储介质已被移除'],
  eParamID_SW_Error_Alarm: ['软件错误', '设备软件发生错误'],
  eParamID_Turn_Off_Camera_Data_Alarm: ['请关闭摄像机数据', '请关闭摄像机数据输出'],
  eParamID_Unsupported_Media_4KP60HQ_Alarm: ['介质不支持', '介质不支持当前音视频格式'],
  // ---- 警告 WARNING ----
  eParamID_Max_Clips_Alarm: ['片段数达显示上限', '片段数量超过界面显示上限'],
  eParamID_Dropped_Frames_Alarm: ['丢帧', '播放或录制过程中出现丢帧'],
  eParamID_Frame_Skipped_Alarm: ['跳帧', '出现跳帧'],
  eParamID_Genlock_Missing_Alarm: ['缺少同步信号', '未检测到 Genlock 参考信号'],
  eParamID_Infinite_Record_Alarm: ['已启用无限录制', '无限录制会在接力前格式化第二块硬盘，将导致数据丢失'],
  eParamID_Input_Error_Alarm: ['输入错误', '输入信号异常'],
  eParamID_Interval_Record_Enabled_Alarm: ['已启用间隔录制', '间隔录制已开启'],
  eParamID_ProRes_MultiChnl_Record_Format_Alarm: ['ProRes 多通道格式无效', '多通道录制格式无效'],
  eParamID_Input_Format_Changed_Alarm: ['视频信号丢失', '输入视频信号曾中断'],
  eParamID_Media_Low_Alarm: ['介质空间不足', '存储介质剩余空间偏低'],
  eParamID_Media_Unformatted_Alarm: ['介质未格式化', '存储介质未格式化'],
  eParamID_Near_Over_Temp_Alarm: ['温度偏高', '设备温度接近上限，请检查散热'],
  eParamID_Near_Over_Volt_Alarm: ['电压偏高', '输入电压接近上限'],
  eParamID_Near_Under_Volt_Alarm: ['电压偏低', '输入电压接近下限'],
  eParamID_No_Clip_Name_Alarm: ['缺少片段名', '未设置片段名'],
  eParamID_No_Video_Input_Alarm: ['无视频输入', '未检测到 SDI 输入信号'],
  eParamID_Output_Error_Alarm: ['输出错误', '输出信号异常'],
  eParamID_PS_1_OFF_Alarm: ['电源 1 关闭', '1 号电源模块未工作'],
  eParamID_PS_2_OFF_Alarm: ['电源 2 关闭', '2 号电源模块未工作'],
  eParamID_Record_Inhibited_Alarm: ['录制被禁止', '当前状态下无法录制'],
  eParamID_Rollover_Media_Full_Alarm: ['接力介质已满', '第二块介质空间已满'],
  eParamID_Rollover_Media_Low_Alarm: ['接力介质空间不足', '第二块介质剩余空间偏低'],
  eParamID_Rollover_Media_Unformatted_Alarm: ['接力介质未格式化', '第二块介质未格式化'],
  eParamID_Rollover_Media_Not_Empty_Alarm: ['接力介质非空', '第二块介质上已有数据'],
  eParamID_Safe_Boot_Mode_Alarm: ['安全启动模式', '设备处于安全启动模式'],
  eParamID_Safeboot_Alarm: ['安全启动', '正在运行安全启动（备份）版本固件'],
  eParamID_Rollover_Unsupported_Media_4KP60HQ_Alarm: ['接力介质不支持', '第二块介质不支持当前音视频格式'],
};

// desc.json 取不到时的兜底参数表（与上表同源）
const ALARM_FALLBACK_IDS = Object.keys(ALARM_CN);

// 每个设备只取一次 desc.json，之后复用（进程内缓存）
const alarmIdCache = new Map();

// 极简 protobuf 解码：只处理 varint(0) 与 length-delimited(2)，够用
function decodeProtoFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let key = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) return out;
      const b = buf[i++];
      key |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
      if (shift > 35) return out;
    }
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) {
      let v = 0;
      let s = 0;
      for (;;) {
        if (i >= buf.length) return out;
        const b = buf[i++];
        v |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
        if (s > 35) return out;
      }
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      let len = 0;
      let s = 0;
      for (;;) {
        if (i >= buf.length) return out;
        const b = buf[i++];
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
        if (s > 35) return out;
      }
      out.push({ field, wire, raw: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      return out; // 未知 wire type，放弃剩余部分
    }
  }
  return out;
}

// base64 → { state, severity, errors: [{text, short}] }
function parseAlarmValue(b64) {
  const r = { state: 0, severity: 0, errors: [] };
  if (typeof b64 !== 'string' || !b64) return r;
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return r;
  }
  for (const f of decodeProtoFields(buf)) {
    if (f.field === 1 && f.wire === 0) r.state = f.value;
    else if (f.field === 2 && f.wire === 0) r.severity = f.value;
    else if (f.field === 3 && f.wire === 2) {
      const e = { text: '', short: '' };
      for (const g of decodeProtoFields(f.raw)) {
        if (g.field === 1) e.text = g.raw.toString('utf8');
        else if (g.field === 2) e.short = g.raw.toString('utf8');
      }
      if (e.text) r.errors.push(e);
    }
  }
  return r;
}

// 从设备 desc.json 里取「class_names 含 alarm 的 data 型参数」，取不到则用内置表
async function getAlarmParamIds(device) {
  const key = device.ip;
  if (alarmIdCache.has(key)) return alarmIdCache.get(key);
  let list = null;
  try {
    const r = await deviceGet(device, '/desc.json');
    const arr = JSON.parse(r.body);
    if (Array.isArray(arr)) {
      list = arr
        .filter(
          (x) =>
            x &&
            x.param_type === 'data' &&
            Array.isArray(x.class_names) &&
            x.class_names.includes('alarm') &&
            validParamName(x.param_id),
        )
        .map((x) => x.param_id);
    }
  } catch {
    list = null;
  }
  if (!list || !list.length) list = ALARM_FALLBACK_IDS.slice();
  alarmIdCache.set(key, list);
  return list;
}

// 并发读取全部告警参数并解码，返回 { total, raised, worst }
async function fetchAlarms(device) {
  const ids = await getAlarmParamIds(device);
  const results = await mapWithConcurrency(ids, 8, async (id) => {
    const r = await deviceGet(device, `/config?action=get&paramid=${id}`);
    const j = parseParamJson(r.body);
    if (!j || typeof j.value !== 'string') return null;
    const a = parseAlarmValue(j.value);
    const cn = ALARM_CN[id] || [id.replace(/^eParamID_|_Alarm$/g, ''), ''];
    return {
      id,
      cn: cn[0],
      cn_hint: cn[1],
      en: id.replace(/^eParamID_|_Alarm$/g, '').replace(/_/g, ' '),
      state: a.state,
      severity: a.severity,
      severity_cn: SEVERITY_CN[a.severity] || String(a.severity),
      severity_key: SEVERITY_KEY[a.severity] || 'WARNING',
      texts: a.errors.map((e) => e.text).filter(Boolean),
    };
  });
  const all = results.filter(Boolean);
  const raised = all.filter((a) => a.state === 1);
  const worst = raised.reduce((m, a) => Math.max(m, a.severity), -1);
  return {
    total: all.length,
    raised_count: raised.length,
    worst: worst < 0 ? 'NORMAL' : SEVERITY_KEY[worst],
    worst_cn: worst < 0 ? '正常' : SEVERITY_CN[worst],
    raised,
  };
}

// ==================== 服务 ====================
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const t0 = Date.now();
  const log = (tag) =>
    console.log(`[${new Date().toLocaleTimeString()}] ${tag} ${p} (${Date.now() - t0}ms)`);

  try {
    // 中文页面
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(INDEX_PATH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      log('PAGE');
      return;
    }

    // 设备清单 + 在线探测
    if (p === '/api/devices') {
      const list = await Promise.all(
        DEVICES.map(async (d) => {
          const info = await probeDevice(d);
          return { id: d.id, name: d.name, ip: d.ip, online: info.online, product: info.product };
        }),
      );
      sendJson(res, 200, { devices: list, source: devicesSource() });
      log('DEV');
      return;
    }

    // —— F1：添加设备（按 IP）——
    // 流程：IPv4 校验 → 查重 → 只读探测 ProductID → 追加写 devices.txt → 热重载
    // 全程不向设备写任何参数。
    if (p === '/api/devices/add' && req.method === 'POST') {
      const rawName = (u.searchParams.get('name') || '').trim();
      const ip = (u.searchParams.get('ip') || '').trim();
      const source = devicesSource();
      if (source === 'env') {
        return sendJson(res, 400, {
          error: '当前设备列表由环境变量 AJA_DEVICES 提供，写 devices.txt 不会生效。请改用 devices.txt，或先清除该环境变量。',
        });
      }
      if (rawName && !isValidDeviceName(rawName)) {
        return sendJson(res, 400, { error: '设备名称非法：不能含 @ , # 或换行，且不超过 32 个字符' });
      }
      if (!isValidIPv4(ip)) {
        return sendJson(res, 400, { error: `IP 格式不对：「${ip || '(空)'}」不是合法的 IPv4（形如 10.10.12.54）` });
      }
      if (DEVICES.some((d) => d.ip === ip)) {
        const exist = DEVICES.find((d) => d.ip === ip);
        return sendJson(res, 409, { error: `该 IP 已在设备列表中（${exist.name}@${exist.ip}）`, device: exist });
      }
      if (rawName && DEVICES.some((d) => d.name.toLowerCase() === rawName.toLowerCase())) {
        return sendJson(res, 409, { error: `设备名称「${rawName}」已存在，请换一个` });
      }

      const probe = await probeForAdd(ip);
      if (!probe.ok) return sendJson(res, 502, { error: `探测失败：${probe.reason}`, ip });

      const name = rawName || 'AJA' + (DEVICES.length + 1);
      let txt = '';
      try {
        txt = fs.readFileSync(DEVICES_FILE, 'utf8');
      } catch {
        txt = '';
      }
      if (txt && !txt.endsWith('\n')) txt += '\n';
      txt += `${name}@${ip}\n`;
      try {
        writeFileAtomic(DEVICES_FILE, txt);
      } catch (e) {
        return sendJson(res, 500, { error: `写入 devices.txt 失败：${e.message}` });
      }
      reloadDevices();
      const added = DEVICES.find((d) => d.ip === ip) || null;
      sendJson(res, 200, {
        ok: true,
        added: added ? { id: added.id, name: added.name, ip: added.ip, product: probe.product } : null,
        product: probe.product,
        note: source === 'env-ip' ? 'devices.txt 优先级高于 AJA_DEVICE_IP，后续以本文件为准' : undefined,
      });
      log('DEV-ADD');
      return;
    }

    // —— F1：移除设备（删除 devices.txt 对应行）——
    if (p === '/api/devices/remove' && req.method === 'POST') {
      if (devicesSource() === 'env') {
        return sendJson(res, 400, { error: '当前设备列表由环境变量 AJA_DEVICES 提供，面板无法移除，请改环境变量。' });
      }
      const dev = resolveDevice(u.searchParams.get('target'));
      if (!dev) return sendJson(res, 400, { error: '未知设备' });
      const lines = readDevicesFileLines();
      let hit = 0;
      const kept = lines.filter((line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return true;
        const m = t.match(/^([^@]+)@(.+)$/);
        const lip = (m ? m[2] : t).trim();
        if (lip === dev.ip) {
          hit++;
          return false;
        }
        return true;
      });
      if (!hit) {
        return sendJson(res, 400, {
          error: `设备 ${dev.name}（${dev.ip}）不在 devices.txt 里（可能来自环境变量或默认值），面板无法移除`,
        });
      }
      // 拒绝移除最后一台：否则 devices.txt 变空会静默回退到默认单台 10.10.12.53，
      // 看上去像"删不掉 / 被改名"，比明确报错更难懂。
      const remains = kept.some((l) => l.trim() && !l.trim().startsWith('#'));
      if (!remains) {
        return sendJson(res, 400, {
          error: '这是设备列表里的最后一台，不能从面板移除（否则面板会回退到默认设备）。确需清空请直接编辑 devices.txt。',
        });
      }
      let txt = kept.join('\n');
      if (!txt.endsWith('\n')) txt += '\n';
      try {
        writeFileAtomic(DEVICES_FILE, txt);
      } catch (e) {
        return sendJson(res, 500, { error: `写入 devices.txt 失败：${e.message}` });
      }
      reloadDevices();
      sendJson(res, 200, {
        ok: true,
        removed: { id: dev.id, name: dev.name, ip: dev.ip },
        devices: DEVICES.map((d) => ({ id: d.id, name: d.name, ip: d.ip })),
      });
      log('DEV-RM');
      return;
    }

    // —— F2：软 Gang（群发走带命令）——
    // cmd=record(3) | stop(4)；devs 为逗号分隔的设备 id/名称，缺省=全部设备。
    // 走带是瞬时命令，verify=0（不回读），与单机按钮语义一致。
    if (p === '/api/gang' && req.method === 'POST') {
      const cmd = (u.searchParams.get('cmd') || '').trim().toLowerCase();
      const value = cmd === 'record' ? 3 : cmd === 'stop' ? 4 : null;
      if (value === null) return sendJson(res, 400, { error: 'cmd 只能是 record 或 stop' });

      // 停止锁：拦在设备写入之前，锁死时连设备都不会被碰到
      if (cmd === 'stop' && STOP_LOCK) {
        return sendJson(res, 403, {
          error: '「全部停止」已锁定（服务端 AJA_STOP_LOCK=1），已拒绝下发',
        });
      }

      const selRaw = (u.searchParams.get('devs') || '').trim();
      let targets;
      if (selRaw) {
        const sels = selRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const resolved = sels.map((s) => resolveDevice(s));
        if (resolved.some((d) => !d)) return sendJson(res, 400, { error: '目标设备列表中有未知设备' });
        // 去重（按 ip）
        const seen = new Set();
        targets = resolved.filter((d) => (seen.has(d.ip) ? false : seen.add(d.ip)));
      } else {
        targets = DEVICES.slice();
      }
      if (!targets.length) return sendJson(res, 400, { error: '没有可下发的设备' });

      const results = await mapWithConcurrency(targets, 4, async (d) => {
        try {
          const r = await deviceGet(
            d,
            `/config?action=set&paramid=eParamID_TransportCommand&value=${value}`,
          );
          const parsed = parseParamJson(r.body);
          return {
            id: d.id,
            name: d.name,
            ip: d.ip,
            ok: !!parsed,
            http_status: r.status,
            returned: parsed ? parsed.value_name || parsed.value : null,
            error: parsed ? null : `设备未确认（HTTP ${r.status}）`,
          };
        } catch (e) {
          return { id: d.id, name: d.name, ip: d.ip, ok: false, error: String((e && e.message) || e) };
        }
      });
      const okCount = results.filter((r) => r.ok).length;
      sendJson(res, 200, {
        ok: true,
        cmd,
        value,
        total: results.length,
        ok_count: okCount,
        fail_count: results.length - okCount,
        results,
      });
      log('GANG');
      return;
    }

    // 健康状态：面板自身 + 各设备在线
    if (p === '/api/health') {
      const devs = await Promise.all(
        DEVICES.map(async (d) => {
          const info = await probeDevice(d);
          return { id: d.id, name: d.name, ip: d.ip, online: info.online, product: info.product };
        }),
      );
      sendJson(res, 200, {
        panel: {
          port: PANEL_PORT,
          started_at: STARTED_AT,
          uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),
          node: process.version,
          stop_lock: STOP_LOCK,
        },
        devices: devs,
      });
      log('HEALTH');
      return;
    }

    // 告警：并发读全部 alarm 参数并解码 protobuf，只回「正在报的」+ 汇总
    // 只读接口，不写任何设备参数。
    if (p === '/api/alarms') {
      const dev = resolveDevice(u.searchParams.get('dev'));
      if (!dev) return sendJson(res, 400, { error: '未知设备' });
      try {
        const out = await fetchAlarms(dev);
        sendJson(res, 200, {
          device_id: dev.id,
          device_name: dev.name,
          ip: dev.ip,
          ...out,
        });
      } catch (e) {
        sendJson(res, 502, { error: `读取告警失败：${String((e && e.message) || e)}` });
      }
      log('ALARMS');
      return;
    }

    // 批量读参数。requested=我们请求的名字；param=设备实际响应的名字
    // （设备会按输入格式自动映射变体，如 EncodeType_MultiChnl_Ch1 → EncodeType_Low_FR_MultiChnl_Ch1，
    //   之后写回必须用设备给出的名字）
    if (p === '/api/all') {
      const dev = resolveDevice(u.searchParams.get('dev'));
      if (!dev) return sendJson(res, 400, { error: '未知设备' });
      const results = await mapWithConcurrency(BATCH_PARAMS, 8, async (name) => {
        const r = await deviceGet(dev, `/config?action=get&paramid=${name}`);
        return parseParamJson(r.body) || { error: `HTTP ${r.status}` };
      });
      const params = {};
      results.forEach((r, i) => {
        if (r && r.param) params[BATCH_PARAMS[i]] = { param: r.param, value: r.value, value_name: r.value_name };
      });
      sendJson(res, 200, { device: dev.ip, device_id: dev.id, device_name: dev.name, params });
      log('API');
      return;
    }

    // 读单个参数（调试用）
    if (p === '/api/get') {
      const dev = resolveDevice(u.searchParams.get('dev'));
      if (!dev) return sendJson(res, 400, { error: '未知设备' });
      const name = u.searchParams.get('param') || '';
      if (!validParamName(name)) return sendJson(res, 400, { error: 'bad param' });
      const r = await deviceGet(dev, `/config?action=get&paramid=${encodeURIComponent(name)}`);
      const parsed = parseParamJson(r.body);
      if (!parsed) return sendJson(res, 502, { error: `设备返回异常（HTTP ${r.status}）` });
      sendJson(res, 200, parsed);
      log('API');
      return;
    }

    // 参数选项表（英文页下拉框同一数据源）
    if (p === '/api/options') {
      const dev = resolveDevice(u.searchParams.get('dev'));
      if (!dev) return sendJson(res, 400, { error: '未知设备' });
      const name = u.searchParams.get('param') || '';
      if (!validParamName(name)) return sendJson(res, 400, { error: 'bad param' });
      const r = await deviceGet(dev, `/options?${encodeURIComponent(name)}`);
      sendJson(res, 200, { param: name, options: parseOptions(r.body) });
      log('API');
      return;
    }

    // 写参数（改动设置会真实下发到设备）
    // verify=0 跳过回读校验（走带命令这类瞬时命令用）
    if (p === '/api/set') {
      const dev = resolveDevice(u.searchParams.get('dev'));
      if (!dev) return sendJson(res, 400, { error: '未知设备' });
      const name = u.searchParams.get('param') || '';
      const value = u.searchParams.get('value') ?? '';
      const doVerify = u.searchParams.get('verify') !== '0';
      if (!validParamName(name)) return sendJson(res, 400, { error: 'bad param' });
      if (!validValue(value)) return sendJson(res, 400, { error: 'bad value' });

      // 停止锁：TransportCommand=4 即「停止」。锁死时一律拒绝，手搓请求也拦得住。
      if (STOP_LOCK && name === 'eParamID_TransportCommand' && Number(value) === 4) {
        return sendJson(res, 403, {
          error: '「停止」已锁定（服务端 AJA_STOP_LOCK=1），已拒绝下发',
        });
      }

      const w = await deviceGet(
        dev,
        `/config?action=set&paramid=${encodeURIComponent(name)}&value=${encodeURIComponent(value)}`,
      );
      const wparsed = parseParamJson(w.body);

      // 回读校验：优先用设备写回时给出的规范名（映射参数会改名）
      let actual = null;
      if (doVerify) {
        const readbackName = (wparsed && wparsed.param) || name;
        try {
          const r = await deviceGet(dev, `/config?action=get&paramid=${encodeURIComponent(readbackName)}`);
          actual = parseParamJson(r.body);
        } catch {
          actual = null;
        }
      }

      const applied = doVerify ? !!(actual && String(actual.value) === String(value)) : null;
      sendJson(res, 200, {
        device_id: dev.id,
        device_name: dev.name,
        param: name,
        requested: value,
        verified: doVerify,
        applied,
        actual_value: actual ? actual.value : null,
        actual_value_name: actual ? actual.value_name : null,
        write_ok: !!wparsed,
        write_status: w.status,
      });
      log('SET');
      return;
    }

    // 素材列表
    if (p === '/api/clips') {
      const dev = resolveDevice(u.searchParams.get('dev'));
      if (!dev) return sendJson(res, 400, { error: '未知设备' });
      const r = await deviceGet(dev, '/clips?action=get_clips');
      let clips = [];
      try {
        clips = JSON.parse(r.body).clips || [];
      } catch {}
      let playlists = [];
      try {
        const rp = await deviceGet(dev, '/clips?action=get_playlists');
        playlists = JSON.parse(rp.body).playlists || [];
      } catch {}
      sendJson(res, 200, { clips, playlists });
      log('API');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (err) {
    // 设备离线/超时统一以 504 返回，前端据此显示离线横幅
    const dev = resolveDevice(u.searchParams.get('dev'));
    const who = dev ? `${dev.name}（${dev.ip}）` : '设备';
    sendJson(res, 504, { error: `无法连接${who}：${err.message || err}` });
  }
});

server.listen(PANEL_PORT, '127.0.0.1', () => {
  console.log('AJA Ki Pro 中文控制台已启动');
  console.log(`  本地面板:  http://127.0.0.1:${PANEL_PORT}`);
  console.log(`  设备列表来源: ${devicesSource() === 'env' ? '环境变量 AJA_DEVICES' : devicesSource() === 'file' ? 'devices.txt' : devicesSource() === 'env-ip' ? '环境变量 AJA_DEVICE_IP' : '内置默认'}`);
  DEVICES.forEach((d) => console.log(`  设备 ${d.name}:  http://${d.ip} （英文版，不受影响）`));
  console.log('  Ctrl+C 停止');
});
