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
//
// 设备列表的读取优先级：AJA_DEVICES 环境变量 > 同目录 devices.txt > AJA_DEVICE_IP > 默认单台。
// 多机（2~8 台）推荐直接编辑同目录的 devices.txt，一行一台，见该文件内的说明。

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEVICE_PORT = Number(process.env.AJA_DEVICE_PORT || 80);
const PANEL_PORT = Number(process.env.AJA_PANEL_PORT || 8321);
const DEVICE_TIMEOUT_MS = Number(process.env.AJA_DEVICE_TIMEOUT_MS || 8000);
const PROBE_TIMEOUT_MS = 2500;
const RETRY_DELAY_MS = 120;
const MAX_VALUE_LEN = 256;

const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const DEVICES_FILE = path.join(__dirname, 'devices.txt');
const WATCHER_STATUS_PATH = path.join(__dirname, '..', '.watcher-status.json');
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

const DEVICES = parseDevices();

// 按 id 或名称解析设备；不传则用第一台（保持旧行为）
function resolveDevice(sel) {
  if (sel === undefined || sel === null || sel === '') return DEVICES[0] || null;
  const s = String(sel).trim().toLowerCase();
  return DEVICES.find((d) => d.id === s || d.name.toLowerCase() === s) || null;
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

function readWatcherStatus() {
  try {
    const raw = fs.readFileSync(WATCHER_STATUS_PATH, 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    const beat = Number(o.last_beat) || 0;
    const age = beat ? Math.max(0, Math.round(Date.now() / 1000 - beat)) : null;
    return { ...o, beat_age_s: age, alive: age !== null && age <= 30 };
  } catch {
    return null;
  }
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
      sendJson(res, 200, { devices: list });
      log('DEV');
      return;
    }

    // 健康状态：面板自身 + 各设备在线 + watcher 心跳
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
        },
        devices: devs,
        watcher: readWatcherStatus(),
      });
      log('HEALTH');
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
  DEVICES.forEach((d) => console.log(`  设备 ${d.name}:  http://${d.ip} （英文版，不受影响）`));
  console.log('  Ctrl+C 停止');
});
