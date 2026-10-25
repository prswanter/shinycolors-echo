/**
 * 闪耀色彩复读机 —— 前端只有一件事：把你说的话，用她的声音原样说回来。
 *
 * 两条路：
 *   按住复读：按住空格/按钮说话，松手 → 听成文字 → 她用她的声音念同一句。
 *   实时复读：麦克风一直开着，你自己断句（静下来约 0.6 秒），她跟着念一句。
 *
 * 这里没有任何对话逻辑：不发文字给模型，不存历史，刷新就清空。
 */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const state = {
    units: [],
    characters: [],
    character: null,
    mode: localStorage.getItem('echo.mode') === 'live' ? 'live' : 'push',
    sttChoice: localStorage.getItem('echo.stt') || '',
    sensitivity: clamp(Number(localStorage.getItem('echo.sens')) || 5, 1, 10),
    inputDevice: localStorage.getItem('echo.in') || '',    // '' = 系统默认
    outputDevice: localStorage.getItem('echo.out') || '',  // '' = 系统默认
    config: null,
    phase: 'idle',          // idle | recording | hearing | speaking
    busy: false,            // 一次复读没走完之前不接受新的
    listening: false,       // 实时复读：麦克风是否开着
    paused: false,          // 正在念或正在听写：别把自己的声音再捡回来
  };

  const cache = new Map();   // 合成过的音频（同一句不重复花钱）

  /* ───────────────────────── 小工具 ───────────────────────── */

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  let toastTimer = 0;
  function toast(message, bad = false) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('bad', bad);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), bad ? 5200 : 3000);
  }

  function setPhase(phase) {
    state.phase = phase;
    renderStatus();
  }

  function renderStatus() {
    const status = $('status');
    const portrait = $('portrait');
    const talk = $('btn-talk');
    const label = $('talk-label');
    const hint = $('hint');
    const live = state.mode === 'live';
    const name = state.character ? state.character.zh : '她';

    portrait.classList.toggle('listening', state.phase === 'recording' || (live && state.listening && state.phase === 'idle'));
    portrait.classList.toggle('speaking', state.phase === 'speaking');
    $('meter').classList.toggle('on', live && state.listening && !useBrowserStt());

    talk.classList.toggle('holding', state.phase === 'recording' && !live);
    talk.classList.toggle('listening', live && state.listening);
    talk.classList.toggle('thinking', state.phase === 'hearing' || (state.phase === 'speaking' && !live));

    if (live) {
      if (state.phase === 'hearing') status.textContent = '在听清你说什么…';
      else if (state.phase === 'speaking') status.textContent = `${name}正在复读`;
      else if (state.phase === 'recording') status.textContent = '在听你说…';
      else if (state.listening) status.textContent = '麦克风开着，说一句就好';
      else status.textContent = '点下面的按钮开始聆听';
      label.textContent = state.listening ? '停止聆听' : '开始聆听';
      hint.innerHTML = state.listening ? '说完一句停顿一下，她就会接上' : '麦克风会一直开着，直到你想停';
    } else {
      if (state.phase === 'hearing') status.textContent = '在听清你说什么…';
      else if (state.phase === 'speaking') status.textContent = `${name}正在复读`;
      else if (state.phase === 'recording') status.textContent = '在听…松手就交给她';
      else status.textContent = '按住空格，或者按住下面的按钮';
      label.textContent = state.phase === 'recording' ? '在听…' : '按住说话';
      hint.innerHTML = '也可以按住 <kbd>空格</kbd>';
    }
  }

  /**
   * 换上她的颜色。浅色（千雪的近白、叶月的浅黄绿）如果照搬，白字会看不清，
   * 所以按亮度挑：浅的压深、用深字；深的直接用白字。
   */
  function setAccent(hex) {
    const root = document.documentElement;
    root.style.setProperty('--c', hex);
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const value = m ? parseInt(m[1], 16) : 0xd98cc0;
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const pale = lum > 0.7;
    root.style.setProperty('--c-ink', `color-mix(in srgb, ${hex} ${pale ? 42 : 62}%, #2a1f33)`);
    root.style.setProperty(
      '--c-fill-a',
      pale ? `color-mix(in srgb, ${hex} 52%, #8d78ab)` : `color-mix(in srgb, ${hex} 94%, #ffffff)`,
    );
    root.style.setProperty('--c-fill-b', `color-mix(in srgb, ${hex} ${pale ? 66 : 60}%, #59467e)`);
    root.style.setProperty('--c-on', pale ? '#2a1f33' : '#ffffff');
  }

  /* ───────────────────────── 数据与选人 ───────────────────────── */

  async function boot() {
    try {
      const [chars, cfg] = await Promise.all([
        fetch('/api/characters').then((r) => r.json()),
        fetch('/api/config').then((r) => r.json()),
      ]);
      state.units = chars.units;
      state.characters = chars.characters;
      state.config = cfg;
    } catch (e) {
      toast('连不上本地服务：确认 python server.py 还在跑', true);
      return;
    }
    renderRoster('');
    bindEvents();
    renderStatus();
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    if (!state.config.fish.configured) {
      toast('还没填 Fish Audio 密钥：点右上角「设置」，填上就能出声了', true);
    }
  }

  /** 网址里带 #/mano 就直接进她的复读页：能收藏，也能第二次打开还是她。 */
  function openFromHash() {
    const id = location.hash.replace(/^#\/?/, '').trim();
    if (!id) {
      if (state.character) leave();
      return;
    }
    if (state.character && state.character.id === id) return;
    const character = state.characters.find((c) => c.id === id);
    if (character) enter(character, true);
  }

  function renderRoster(keyword) {
    const q = keyword.trim().toLowerCase();
    const roster = $('roster');
    roster.innerHTML = '';
    let shown = 0;

    for (const unit of state.units) {
      const list = state.characters.filter((c) => c.unit === unit && match(c, q));
      if (!list.length) continue;
      shown += list.length;

      const section = document.createElement('section');
      section.className = 'unit';
      const h = document.createElement('h2');
      h.className = 'unit-name';
      h.textContent = unit;
      section.append(h);

      const cards = document.createElement('div');
      cards.className = 'cards';
      for (const c of list) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'card';
        card.style.setProperty('--k', c.color);
        card.title = `${c.name}（${c.zh}）`;
        card.innerHTML = `
          <img src="${c.avatar}" alt="" loading="lazy" />
          <span class="c-name">${escapeHtml(c.name)}</span>
          <span class="c-sub">${escapeHtml(c.romaji || c.zh)}</span>`;
        card.addEventListener('click', () => enter(c));
        cards.append(card);
      }
      section.append(cards);
      roster.append(section);
    }

    if (!shown) {
      const empty = document.createElement('p');
      empty.className = 'no-result';
      empty.textContent = '没有这个人——换个写法试试，比如「真乃」「はづき」「hazuki」。';
      roster.append(empty);
    }
    $('roster-count').textContent = q ? `${shown} / ${state.characters.length} 位` : `${state.characters.length} 位可复读`;
  }

  function match(c, q) {
    if (!q) return true;
    return [c.name, c.zh, c.romaji, c.id, c.unit].some((v) => (v || '').toLowerCase().includes(q));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function enter(character, fromHash = false) {
    stopEverything();
    state.character = character;
    setAccent(character.color);
    $('echo-avatar').src = character.avatar;
    $('echo-name').textContent = character.name;
    $('echo-unit').textContent = `${character.unit}${character.romaji ? ' · ' + character.romaji : ''}`;
    $('portrait-img').src = character.avatar;
    $('portrait-img').alt = character.name;
    $('view-home').hidden = true;
    $('view-echo').hidden = false;
    $('log').innerHTML = `
      <div class="empty" id="log-empty">
        <p class="empty-title">这里只放复读</p>
        <p>你说一句，她原样说回来。<br />说错了、说外语、说奇怪的话，她都照说不误——她只是在复读。</p>
      </div>`;
    renderStatus();
    document.title = `${character.zh} · 闪耀色彩复读机`;
    if (!fromHash) {
      history.replaceState(null, '', `#/${character.id}`);
    }
  }

  function leave() {
    stopEverything();
    state.character = null;
    setAccent('#d98cc0');
    $('view-echo').hidden = true;
    $('view-home').hidden = false;
    document.title = '闪耀色彩复读机';
    if (location.hash) history.replaceState(null, '', location.pathname);
  }

  function stopEverything() {
    if (state.listening) listen.stop();
    player.stop();
    state.busy = false;
    state.paused = false;
    setPhase('idle');
  }

  /* ───────────────────────── 说话与播放 ───────────────────────── */

  /** 能不能选播放设备。Chrome / Edge 可以，Safari / Firefox 不行。 */
  const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  const sameDevice = (id) => (!id || id === 'default' ? '' : id);

  /** 把她的声音送进选好的扬声器；设备没了就退回默认，别让复读卡住。 */
  async function applyOutputDevice() {
    if (!canPickOutput) return;
    const audio = player.audio;
    const wanted = sameDevice(state.outputDevice);
    if (sameDevice(audio.sinkId) === wanted) return;
    try {
      await audio.setSinkId(wanted);
    } catch {
      state.outputDevice = '';
      localStorage.setItem('echo.out', '');
      try { await audio.setSinkId(''); } catch { /* noop */ }
      toast('那个播放设备用不了，先走系统默认', true);
    }
  }

  const player = {
    audio: new Audio(),
    url: null,
    finish: null,
    playing: false,

    async say(text) {
      const character = state.character;
      if (!character) throw new Error('还没选人');
      const key = `${character.id}\u0000${text}`;
      let url = cache.get(key);
      if (!url) {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ character: character.id, text }),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.error || `语音合成失败（${res.status}）`);
        }
        url = URL.createObjectURL(await res.blob());
        cache.set(key, url);
        if (cache.size > 80) {
          const [oldKey, oldUrl] = cache.entries().next().value;
          URL.revokeObjectURL(oldUrl);
          cache.delete(oldKey);
        }
      }
      return this.play(url, text);
    },

    async play(url, text) {
      this.stop();
      await applyOutputDevice();
      return new Promise((resolve) => {
        const audio = this.audio;
        this.url = url;
        this.finish = () => { this.finish = null; resolve(); };
        audio.src = url;
        audio.onended = () => { this.playing = false; this.finish?.(); };
        audio.onerror = () => { this.playing = false; this.finish?.(); };
        const started = audio.play();
        this.playing = true;
        if (started && started.catch) started.catch(() => { this.playing = false; this.finish?.(); });
      });
    },

    stop() {
      if (!this.playing && !this.audio.src) return;
      this.audio.pause();
      this.audio.currentTime = 0;
      this.playing = false;
      this.finish?.();
    },
  };

  /* ───────────────────────── 复读记录 ───────────────────────── */

  function addMine(text) {
    $('log-empty')?.remove();
    const row = document.createElement('div');
    row.className = 'bubble-row me';
    row.innerHTML = `<div class="bubble"><span class="said">${escapeHtml(text)}</span></div>`;
    $('log').append(row);
    scrollLog();
    return row;
  }

  function addPendingHer() {
    $('log-empty')?.remove();
    const row = document.createElement('div');
    row.className = 'bubble-row her pending';
    row.innerHTML = `
      <img class="avatar-xs" src="${state.character.avatar}" alt="" />
      <div class="bubble"><span>正在变成她的声音</span><span class="dots"><i></i><i></i><i></i></span></div>`;
    $('log').append(row);
    scrollLog();
    return row;
  }

  function fillHer(row, text) {
    row.classList.remove('pending');
    row.innerHTML = `<img class="avatar-xs" src="${state.character.avatar}" alt="" /><div class="bubble playing"><span class="said">${escapeHtml(text)}</span><button class="replay" type="button" title="再听一次" aria-label="再听一次"><svg class="icon"><use href="#i-play"/></svg></button></div>`;
    const bubble = row.querySelector('.bubble');
    const button = row.querySelector('.replay');
    button.addEventListener('click', async () => {
      if (state.busy) return;
      try {
        bubble.classList.add('playing');
        await player.play(button.dataset.url || cache.get(`${state.character.id}\u0000${text}`), text);
      } catch { /* 忽略：再听失败不打扰 */ }
      bubble.classList.remove('playing');
    });
    scrollLog();
    return { row, bubble, button };
  }

  function scrollLog() {
    const log = $('log');
    log.scrollTop = log.scrollHeight;
  }

  /* ───────────────────────── 一次复读 ───────────────────────── */

  /**
   * 文字进来，她的声音出去。两条气泡、一段音频，别的一概没有。
   * `heard` 是听写出来的原文，`say` 交给她的也是这一句（复读，不改写）。
   */
  async function echoOnce(text) {
    const said = text.trim();
    if (!said) return;
    if (!state.character) return;
    state.busy = true;
    if (state.mode === 'live') state.paused = true;

    addMine(said);
    const pending = addPendingHer();
    setPhase('speaking');

    try {
      // 先拿到音频再点亮气泡，免得「正在变成她的声音」闪一下又变成字。
      const url = await ttsUrl(said);
      const filled = fillHer(pending, said);
      filled.button.dataset.url = url;
      setPhase('speaking');
      await player.play(url, said);
      filled.bubble.classList.remove('playing');
    } catch (e) {
      pending.remove();
      addHerFailure(e.message);
    } finally {
      state.busy = false;
      setPhase('idle');
      if (state.mode === 'live') {
        state.paused = false;
        resetVad();
      }
    }
  }

  /** 拿到这句的音频地址：同一句只合成一次。 */
  async function ttsUrl(text) {
    const character = state.character;
    const key = `${character.id}\u0000${text}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character: character.id, text }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `语音合成失败（${res.status}）`);
    }
    const url = URL.createObjectURL(await res.blob());
    cache.set(key, url);
    if (cache.size > 80) {
      const [oldKey, oldUrl] = cache.entries().next().value;
      URL.revokeObjectURL(oldUrl);
      cache.delete(oldKey);
    }
    return url;
  }

  function addHerFailure(message) {
    $('log-empty')?.remove();
    const row = document.createElement('div');
    row.className = 'bubble-row her';
    row.innerHTML = `<div class="bubble" style="color:#8e2f47;background:#fdf0f3;border-color:#f3ccd6;font-size:13.5px">${escapeHtml(message)}</div>`;
    $('log').append(row);
    scrollLog();
  }

  /* ───────────────────────── 麦克风 ───────────────────────── */

  class Mic {
    constructor() {
      this.stream = null;
      this.ctx = null;
      this.source = null;
      this.node = null;
      this.rate = 48000;
      this.onFrame = null;
    }

    async open() {
      if (this.node) return this;
      let stream;
      const wanted = state.inputDevice;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(wanted ? { deviceId: { ideal: wanted } } : {}),
          },
        });
      } catch (e) {
        const why = e && e.name === 'NotAllowedError'
          ? '浏览器没给麦克风权限'
          : e && e.name === 'NotFoundError'
            ? '没找到麦克风'
            : (e && e.message) || '打不开麦克风';
        throw new Error(why);
      }
      // 选的那只麦克风拔了：浏览器会拿别的顶上，这里说一声并清掉选择。
      // 有些环境（包括部分虚拟声卡）只会报 'default'，那种情况判断不了，就不动它。
      if (wanted) {
        const used = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
        if (used && used !== 'default' && used !== wanted) {
          state.inputDevice = '';
          localStorage.removeItem('echo.in');
          if (!$('scrim').hidden) $('in-device').value = '';
          toast('选的那只麦克风不在了，改用系统默认', true);
        }
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === 'suspended') await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(2048, 1, 1);
      this.rate = ctx.sampleRate;
      node.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        if (this.onFrame) this.onFrame(new Float32Array(data), rms(data));
      };
      source.connect(node);
      node.connect(ctx.destination);
      Object.assign(this, { stream, ctx, source, node });
      return this;
    }

    close() {
      this.onFrame = null;
      try { this.node?.disconnect(); } catch { /* noop */ }
      try { this.source?.disconnect(); } catch { /* noop */ }
      this.stream?.getTracks().forEach((t) => t.stop());
      const ctx = this.ctx;
      Object.assign(this, { stream: null, ctx: null, source: null, node: null });
      if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
    }
  }

  const mic = new Mic();

  /* ───────────────────────── 设备列表 ───────────────────────── */

  async function listAudioDevices() {
    const empty = { inputs: [], outputs: [] };
    if (!navigator.mediaDevices?.enumerateDevices) return empty;
    let all;
    try {
      all = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return empty;
    }
    return {
      inputs: all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default'),
      outputs: all.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default'),
    };
  }

  /** 填一个下拉：第一项是系统默认，后面按浏览器给的顺序排。 */
  function fillDeviceSelect(select, devices, saved, prefix) {
    select.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '系统默认';
    select.append(auto);

    let found = !saved;
    devices.forEach((device, i) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `${prefix} ${i + 1}`;
      select.append(option);
      if (device.deviceId === saved) found = true;
    });
    select.value = found ? saved : '';
    return found;
  }

  function forgetDevice(kind) {
    if (kind === 'in') {
      state.inputDevice = '';
      localStorage.removeItem('echo.in');
    } else {
      state.outputDevice = '';
      localStorage.removeItem('echo.out');
    }
  }

  /** 麦克风权限到哪一步了：granted / prompt / denied，问不出来就算 unknown。 */
  async function micPermission() {
    try {
      const status = await navigator.permissions.query({ name: 'microphone' });
      return status.state;
    } catch {
      return 'unknown';
    }
  }

  /**
   * 没授权麦克风之前浏览器会把设备名和 deviceId 一起藏起来，只能显示「麦克风 1」这种序号，
   * 所以下拉下面那行提示要说清楚现在是什么状况、点哪个按钮能解决。
   */
  async function refreshDeviceSelects() {
    const [{ inputs, outputs }, perm] = await Promise.all([listAudioDevices(), micPermission()]);

    if (!fillDeviceSelect($('in-device'), inputs, state.inputDevice, '麦克风')) {
      forgetDevice('in');
    }

    if (!canPickOutput) {
      const out = $('out-device');
      out.innerHTML = '<option value="">系统默认</option>';
      out.disabled = true;
      $('out-tip').textContent = '这个浏览器不支持选播放设备（Chrome / Edge 可以），声音会走系统默认。';
    } else {
      $('out-device').disabled = false;
      if (!fillDeviceSelect($('out-device'), outputs, state.outputDevice, '扬声器')) {
        forgetDevice('out');
      }
      $('out-tip').textContent = outputs.length
        ? '她的声音从哪个设备出来。改完立即生效。'
        : '设备名要等浏览器给过麦克风权限才显示，先点右边刷新。';
    }

    if (useBrowserStt()) {
      $('in-tip').textContent = '浏览器自带识别固定用系统默认麦克风；想指定设备，把听写方式换成百炼。';
    } else if (inputs.length) {
      $('in-tip').textContent = '用哪只麦克风听你说话。改完立即生效。';
    } else if (perm === 'denied') {
      $('in-tip').textContent = '浏览器把麦克风权限拒掉了。点地址栏左边的图标改成允许，再点右边刷新。';
    } else if (perm === 'granted') {
      $('in-tip').textContent = '系统里没有可用的麦克风。插上设备后点右边刷新。';
    } else {
      $('in-tip').textContent = '还没给麦克风权限，看不到设备名。点右边刷新授权。';
    }
  }

  function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  function concat(frames) {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const f of frames) { out.set(f, at); at += f.length; }
    return out;
  }

  function resample(samples, from, to) {
    if (from === to) return samples;
    const length = Math.round((samples.length * to) / from);
    const out = new Float32Array(length);
    const step = from / to;
    for (let i = 0; i < length; i += 1) {
      const at = i * step;
      const low = Math.floor(at);
      const high = Math.min(low + 1, samples.length - 1);
      const weight = at - low;
      out[i] = samples[low] * (1 - weight) + samples[high] * weight;
    }
    return out;
  }

  /** 16 kHz 单声道 16 位的 WAV：百炼要的就是这个。 */
  function toWav(samples, rate) {
    const data = resample(samples, rate, 16000);
    const buffer = new ArrayBuffer(44 + data.length * 2);
    const view = new DataView(buffer);
    const text = (at, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF');
    view.setUint32(4, 36 + data.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, data.length * 2, true);
    let at = 44;
    for (let i = 0; i < data.length; i += 1, at += 2) {
      const s = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  /* ───────────────────────── 听写 ───────────────────────── */

  function useBrowserStt() {
    const choice = state.sttChoice || (state.config?.asr?.configured ? 'server' : 'browser');
    return choice === 'browser';
  }

  /** 服务端听写：一段 WAV → 文字。 */
  async function hear(wav) {
    const res = await fetch('/api/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: wav,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `语音识别失败（${res.status}）`);
    }
    const { text } = await res.json();
    return text;
  }

  /* ───────────────────────── 按住复读 ───────────────────────── */

  const push = {
    frames: [],
    opening: false,
    released: false,
    startedAt: 0,
  };

  async function pushStart() {
    if (state.busy || state.phase === 'recording') return;
    if (useBrowserStt()) return browserPushStart();
    push.frames = [];
    push.released = false;
    push.opening = true;
    setPhase('recording');
    try {
      await mic.open();
    } catch (e) {
      push.opening = false;
      setPhase('idle');
      toast(e.message, true);
      return;
    }
    push.opening = false;
    if (push.released) { setPhase('idle'); mic.close(); return; }
    push.startedAt = performance.now();
    mic.onFrame = (data) => {
      if (push.frames.length < 400) push.frames.push(data);
    };
  }

  async function pushEnd() {
    if (useBrowserStt()) return browserPushEnd();
    push.released = true;
    if (push.opening) return;
    if (state.phase !== 'recording') return;
    mic.onFrame = null;
    const frames = push.frames;
    push.frames = [];
    const samples = concat(frames);
    const seconds = samples.length / mic.rate;
    if (seconds < 0.25) { setPhase('idle'); return; }

    state.busy = true;
    setPhase('hearing');
    try {
      const text = await hear(toWav(samples, mic.rate));
      state.busy = false;
      setPhase('idle');
      if (!text || !text.trim()) { toast('没听清，再说一次？'); return; }
      await echoOnce(text);
    } catch (e) {
      state.busy = false;
      setPhase('idle');
      toast(e.message, true);
    } finally {
      if (!state.listening) mic.close();
    }
  }

  /* 浏览器识别：按住时开始听，松手时收尾。 */
  let browserRec = null;
  let browserResolve = null;
  let browserFinal = '';
  let browserInterim = '';

  function browserPushStart() {
    if (!SR) { toast('这个浏览器不支持语音识别，换 Chrome 或 Edge', true); return; }
    browserFinal = '';
    browserInterim = '';
    setPhase('recording');
    const rec = new SR();
    browserRec = rec;
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let finals = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finals += result[0].transcript;
        else interim += result[0].transcript;
      }
      browserFinal += finals;
      browserInterim = interim;
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        toast('浏览器没给麦克风权限', true);
      } else if (event.error === 'network') {
        toast('浏览器语音识别连不上服务器：换用百炼识别吧', true);
      }
    };
    try { rec.start(); } catch { /* 已经在听了 */ }
  }

  async function browserPushEnd() {
    if (state.phase !== 'recording') return;
    const rec = browserRec;
    browserRec = null;
    if (!rec) { setPhase('idle'); return; }
    setPhase('hearing');
    const text = await new Promise((resolve) => {
      browserResolve = resolve;
      rec.onend = () => resolve((browserFinal || browserInterim).trim());
      try { rec.stop(); } catch { resolve((browserFinal || browserInterim).trim()); }
      setTimeout(() => resolve((browserFinal || browserInterim).trim()), 2500);
    });
    rec.onresult = null;
    rec.onerror = null;
    browserResolve = null;
    setPhase('idle');
    if (!text) { toast('没听清，再说一次？'); return; }
    await echoOnce(text);
  }

  /* ───────────────────────── 实时复读 ───────────────────────── */

  const vad = {
    floor: 0.004,
    loudMs: 0,
    silenceMs: 0,
    speechMs: 0,
    speaking: false,
    frames: [],
    pre: [],
  };

  function resetVad() {
    Object.assign(vad, { loudMs: 0, silenceMs: 0, speechMs: 0, speaking: false, frames: [], pre: [] });
    renderMeter(0);
  }

  function sensFactor() {
    // 1 → 迟钝（要大声），10 → 灵敏（气声也收）
    return 1.9 - (state.sensitivity - 1) * 0.15;
  }

  async function startListening() {
    if (!state.character) return;
    if (useBrowserStt()) return startBrowserLive();
    try {
      await mic.open();
    } catch (e) {
      toast(e.message, true);
      return;
    }
    state.listening = true;
    state.paused = false;
    resetVad();
    mic.onFrame = liveFrame;
    renderStatus();
  }

  function stopListening() {
    if (!state.listening) return;
    state.listening = false;
    mic.onFrame = null;
    mic.close();
    resetVad();
    renderStatus();
  }

  function toggleListening() {
    if (state.listening) listen.stop();
    else listen.start();
  }

  function liveFrame(samples, level) {
    renderMeter(level);
    if (state.paused || state.busy) return;
    const frameMs = (samples.length / mic.rate) * 1000;
    const threshold = Math.max(0.006, vad.floor * 2.6) * sensFactor();
    const loud = level > threshold;

    if (!vad.speaking) {
      if (!loud) vad.floor = vad.floor * 0.96 + level * 0.04;
      vad.pre.push(samples);
      if (vad.pre.length > 6) vad.pre.shift();       // 约 250 ms 的提前量
      if (loud) {
        vad.loudMs += frameMs;
        if (vad.loudMs > 100) {
          vad.speaking = true;
          vad.frames = vad.pre.slice();
          vad.pre = [];
          vad.speechMs = vad.loudMs;
          vad.silenceMs = 0;
          setPhase('recording');
        }
      } else {
        vad.loudMs = 0;
      }
      return;
    }

    vad.frames.push(samples);
    if (loud) { vad.speechMs += frameMs; vad.silenceMs = 0; }
    else vad.silenceMs += frameMs;

    const done = vad.silenceMs > 620 && vad.speechMs > 240;
    const overlong = vad.speechMs > 14000;
    if (done || overlong) cutUtterance();
  }

  async function cutUtterance() {
    const frames = vad.frames;
    const speechMs = vad.speechMs;
    const rate = mic.rate;
    resetVad();
    if (speechMs < 240) return;
    const samples = concat(frames);
    if (samples.length / rate < 0.24) return;

    state.busy = true;
    state.paused = true;
    setPhase('hearing');
    let text = '';
    try {
      text = await hear(toWav(samples, rate));
    } catch (e) {
      state.busy = false;
      state.paused = false;
      setPhase('idle');
      toast(e.message, true);
      stopListening();
      return;
    }
    state.busy = false;
    if (!text || !text.trim()) {
      state.paused = false;
      setPhase('idle');
      return;
    }
    await echoOnce(text);
  }

  /* 浏览器识别的实时模式：它自己会给最终结果，拿到一句就复读。 */
  let liveRec = null;
  let liveStopping = false;

  function startBrowserLive() {
    if (!SR) { toast('这个浏览器不支持语音识别，换 Chrome 或 Edge', true); return; }
    const rec = new SR();
    liveRec = rec;
    liveStopping = false;
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let finals = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finals += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) $('status').textContent = `在听你说：${interim.slice(-18)}`;
      if (finals.trim() && !state.busy) {
        void echoOnce(finals.trim());
      }
    };
    rec.onend = () => {
      if (!liveStopping && state.listening) {
        // 网络断的时候 Chrome 会立刻 end，马上重启会烧成死循环，垫一点延迟。
        setTimeout(() => {
          if (!liveStopping && state.listening && liveRec === rec) {
            try { rec.start(); } catch { /* noop */ }
          }
        }, 500);
      }
    };
    let lastNetToast = 0;
    rec.onerror = (event) => {
      if (event.error === 'network') {
        // 不停：onend 会自动重开麦克风接着试。提示限流，别一次断线刷一屏。
        const now = Date.now();
        if (now - lastNetToast > 15000) {
          lastNetToast = now;
          toast('浏览器语音识别连不上服务器，会一直重试；一直不行就换百炼识别', true);
        } else {
          $('status').textContent = '识别服务连不上，重试中…';
        }
      }
    };
    state.listening = true;
    state.paused = false;
    try { rec.start(); } catch { /* noop */ }
    renderStatus();
  }

  function stopBrowserLive() {
    liveStopping = true;
    state.listening = false;
    try { liveRec?.stop(); } catch { /* noop */ }
    liveRec = null;
    renderStatus();
  }

  // 把两条路合成一个开关
  const listen = {
    start: () => (useBrowserStt() ? startBrowserLive() : startListening()),
    stop: () => (useBrowserStt() ? stopBrowserLive() : stopListening()),
  };

  function renderMeter(level) {
    const bars = $('meter').children;
    const value = clamp(level * 9, 0, 1);
    for (let i = 0; i < bars.length; i += 1) {
      const wobble = 0.55 + 0.45 * Math.sin(performance.now() / 130 + i);
      bars[i].style.height = `${4 + value * 14 * wobble}px`;
    }
  }

  /* ───────────────────────── 事件 ───────────────────────── */

  function bindEvents() {
    $('search').addEventListener('input', (e) => renderRoster(e.target.value));
    $('btn-back').addEventListener('click', leave);

    // 按住复读：指针（鼠标 / 手指）
    const talk = $('btn-talk');
    talk.addEventListener('pointerdown', (e) => {
      if (state.mode === 'live') { toggleListening(); return; }
      e.preventDefault();
      talk.setPointerCapture(e.pointerId);
      void pushStart();
    });
    talk.addEventListener('pointerup', (e) => {
      if (state.mode === 'live') return;
      if (talk.hasPointerCapture(e.pointerId)) talk.releasePointerCapture(e.pointerId);
      void pushEnd();
    });
    talk.addEventListener('pointercancel', () => { if (state.mode === 'push') void pushEnd(); });
    talk.addEventListener('contextmenu', (e) => e.preventDefault());

    // 空格按住说话
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      if ($('view-echo').hidden || !$('scrim').hidden) return;
      if (state.mode !== 'push') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      e.preventDefault();
      void pushStart();
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      if (state.mode !== 'push' || $('view-echo').hidden) return;
      e.preventDefault();
      void pushEnd();
    });
    // 按下空格切走了窗口，松手收不到：这时候也交上去。
    window.addEventListener('blur', () => {
      if (state.mode === 'push' && state.phase === 'recording') void pushEnd();
    });

    // 两种模式
    for (const button of document.querySelectorAll('[data-mode]')) {
      button.addEventListener('click', () => {
        if (state.mode === button.dataset.mode) return;
        stopEverything();
        state.mode = button.dataset.mode;
        localStorage.setItem('echo.mode', state.mode);
        for (const b of document.querySelectorAll('[data-mode]')) {
          b.setAttribute('aria-checked', String(b === button));
        }
        renderStatus();
      });
      button.setAttribute('aria-checked', String(button.dataset.mode === state.mode));
    }

    // 打字让她复读：两种模式都行，实时开着也照常，跟说话互不打断
    $('type-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('type-text');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      void echoOnce(text);
    });

    $('btn-clear').addEventListener('click', () => {
      $('log').innerHTML = `
        <div class="empty" id="log-empty">
          <p class="empty-title">这里只放复读</p>
          <p>你说一句，她原样说回来。<br />说错了、说外语、说奇怪的话，她都照说不误——她只是在复读。</p>
        </div>`;
      toast('清掉了');
    });

    // 设置面板
    for (const b of document.querySelectorAll('[data-open-settings]')) {
      b.addEventListener('click', openSettings);
    }
    $('btn-close-settings').addEventListener('click', closeSettings);
    $('scrim').addEventListener('click', (e) => { if (e.target === $('scrim')) closeSettings(); });
    $('btn-save').addEventListener('click', saveSettings);
    $('btn-test').addEventListener('click', testVoice);
    $('sensitivity').addEventListener('input', (e) => {
      state.sensitivity = clamp(Number(e.target.value), 1, 10);
      localStorage.setItem('echo.sens', String(state.sensitivity));
      $('sens-value').textContent = String(state.sensitivity);
    });
    $('stt-mode').addEventListener('change', (e) => {
      if (e.target.value === 'browser' && !SR) {
        toast('这个浏览器不支持自带识别，换 Chrome 或 Edge', true);
        e.target.value = 'server';
        return;
      }
      state.sttChoice = e.target.value;
      localStorage.setItem('echo.stt', state.sttChoice);
      refreshDeviceSelects();
      if (state.listening) { listen.stop(); listen.start(); }
    });

    // 输入设备：改完立刻换（正在听就重开一次麦克风）
    $('in-device').addEventListener('change', async (e) => {
      state.inputDevice = e.target.value;
      if (state.inputDevice) localStorage.setItem('echo.in', state.inputDevice);
      else localStorage.removeItem('echo.in');
      if (!mic.node) return;
      const wasListening = state.listening;
      mic.close();
      if (!wasListening) return;
      try {
        await mic.open();
        mic.onFrame = liveFrame;
      } catch (err) {
        state.listening = false;
        renderStatus();
        toast(err.message, true);
      }
    });

    // 输出设备：改完立刻生效（正在放的话会当场切过去）
    $('out-device').addEventListener('change', async (e) => {
      state.outputDevice = e.target.value;
      if (state.outputDevice) localStorage.setItem('echo.out', state.outputDevice);
      else localStorage.removeItem('echo.out');
      if (!canPickOutput) return;
      try {
        await player.audio.setSinkId(state.outputDevice || '');
      } catch {
        forgetDevice('out');
        e.target.value = '';
        toast('这个设备换不了，先用系统默认', true);
      }
    });

    $('btn-refresh-devices').addEventListener('click', async (e) => {
      const button = e.currentTarget;
      button.classList.add('spin');
      try {
        const { inputs } = await listAudioDevices();
        // 从没授权过时设备名是空的，问一次权限才拿得到名字（也才能区分哪个是哪个）
        if (!inputs.some((d) => d.label) && navigator.mediaDevices?.getUserMedia) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => t.stop());
          } catch {
            toast('没拿到麦克风权限，只能显示默认设备', true);
          }
        }
        await refreshDeviceSelects();
      } finally {
        setTimeout(() => button.classList.remove('spin'), 450);
      }
    });

    // 插拔耳机 / 麦克风时，面板开着就顺手更新列表
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (!$('scrim').hidden) refreshDeviceSelects();
    });
  }

  /* ───────────────────────── 设置 ───────────────────────── */

  function openSettings() {
    const cfg = state.config;
    if (!cfg) return;
    const fishKey = $('fish-key');
    fishKey.value = '';
    fishKey.placeholder = cfg.fish.configured ? `已配置：${cfg.fish.masked}（留空不改）` : '粘贴 Fish Audio 的 API key';
    const dashKey = $('dash-key');
    dashKey.value = '';
    dashKey.placeholder = cfg.asr.configured ? `已配置：${cfg.asr.masked}（留空不改）` : '粘贴百炼的 API key（可选）';

    const model = $('fish-model');
    model.innerHTML = '';
    for (const name of cfg.fish.models) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name === 's2.1-pro-free' ? `${name}（免费）` : name;
      model.append(option);
    }
    model.value = cfg.fish.model;

    $('stt-mode').value = state.sttChoice || (cfg.asr.configured ? 'server' : 'browser');
    $('stt-tip').textContent = SR
      ? '浏览器识别用 Chrome / Edge 自带的语音识别，不需要额外密钥。'
      : '这个浏览器不支持自带识别，只能用百炼。';
    $('sensitivity').value = String(state.sensitivity);
    $('sens-value').textContent = String(state.sensitivity);

    $('scrim').hidden = false;
    document.body.classList.add('sheet-open');
    void refreshDeviceSelects();
  }

  function closeSettings() {
    $('scrim').hidden = true;
    document.body.classList.remove('sheet-open');
  }

  async function saveSettings() {
    const patch = {};
    const fish = $('fish-key').value.trim();
    if (fish) patch.fish_api_key = fish;
    patch.fish_model = $('fish-model').value;
    const dash = $('dash-key').value.trim();
    if (dash) patch.dashscope_api_key = dash;
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`保存失败（${res.status}）`);
      state.config = await res.json();
      toast('存好了' + (state.config.fish.configured ? '' : '，不过 Fish 密钥还是空的'));
      closeSettings();
    } catch (e) {
      toast(e.message || '保存失败', true);
    }
  }

  async function testVoice() {
    const character = state.character || state.characters[0];
    if (!character) return;
    const previous = state.character;
    state.character = character;
    setAccent(character.color);
    const button = $('btn-test');
    button.disabled = true;
    button.textContent = '合成中…';
    try {
      await player.say(`你好呀，我是${character.zh}。这句是复读机在试音。`);
      toast('这就是她的声音');
    } catch (e) {
      toast(e.message, true);
    } finally {
      button.disabled = false;
      button.textContent = '试听一句';
      if (!previous) setAccent('#d98cc0');
      state.character = previous;
    }
  }

  boot();
})();
