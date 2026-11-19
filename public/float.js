/* 复读浮窗的前端。
 *
 * 这个页面不是从复读页里「开」出来的，而是单独一个窗口（无标题栏、置顶、整窗半透明），
 * 所以它自己完成三件事：拉角色表、调 /api/tts 合成、自己放音。
 * 声音从这里出去，跟主页面那个播放器互不影响。
 *
 * 页面本身没有权限改 Windows 窗口的透明度，那一层由 float_win.py 负责；
 * 两边通过 /api/float/state 对齐「现在是谁」和「现在多透」。
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const input = $('text');
  const pick = $('pick');
  const ava = $('ava');

  const HINT = '打一句，回车就复读';

  /** float_win.py 那边按了快捷键会先把窗口叫到前台，再喊这一声把光标放进输入框。
   *  窗口本来就前台、焦点却在下拉框里的时候不会有 focus 事件，只能靠这一声。 */
  window.echoFocus = () => {
    if (document.activeElement === input) return;
    input.focus();
  };

  const state = {
    characters: [],
    units: [],
    character: null,
    queue: [],
    pumping: false,
    timer: null,
    seen: '',                 // 上次跟服务端对齐时的角色，用来发现「网页那边换人了」
    cache: new Map(),
  };

  const audio = new Audio();
  audio.preload = 'auto';
  // 排查「声音到底从哪只音箱出去」时用得到：控制台里看 echoAudio.sinkId
  window.echoAudio = audio;

  /* ───────────── 角色 ───────────── */

  function setAccent(color) {
    document.documentElement.style.setProperty('--c', color || '#d98cc0');
  }

  function buildRoster() {
    const units = state.units.length
      ? state.units
      : [...new Set(state.characters.map((c) => c.unit))];
    pick.innerHTML = '';
    for (const unit of units) {
      const list = state.characters.filter((c) => c.unit === unit);
      if (!list.length) continue;
      const group = document.createElement('optgroup');
      group.label = unit;
      for (const c of list) {
        const option = document.createElement('option');
        option.value = c.id;
        option.textContent = c.name;
        group.append(option);
      }
      pick.append(group);
    }
  }

  function use(character, tell = true) {
    state.character = character;
    state.seen = character.id;
    try { localStorage.setItem('echo.floatChar', character.id); } catch { /* 隐私模式 */ }
    pick.value = character.id;
    ava.style.backgroundImage = `url("${character.avatar}")`;
    ava.title = `${character.name} · 点这里换人`;
    setAccent(character.color);
    if (tell) void push({ character: character.id });
  }

  /* ───────────── 跟服务端对齐 ───────────── */

  async function push(patch) {
    try {
      await fetch('/api/float/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch { /* 服务断了，浮窗还能继续用已经加载的角色 */ }
  }

  async function pull() {
    try {
      const res = await fetch('/api/float/state', { cache: 'no-store' });
      return await res.json();
    } catch {
      return {};
    }
  }

  /* ───────────── 合声与播放 ───────────── */

  /* 播放设备：网页里选了「扬声器」之后，浮窗的声音也得从同一个地方出去。
   * 坑在于两个窗口的 deviceId 不是一套（WebView2 有自己的 profile，id 是加过盐的），
   * 所以只能按设备名去认；名字也对不上才退回系统默认，而且要明说。
   * 名单能看见靠的是 float_win.py 给 WebView2 加的 --use-fake-ui-for-media-stream。 */
  const sink = { list: [], key: null, ready: false, applied: '' };

  async function loadOutputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return false;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const outs = all.filter(
        (d) => d.kind === 'audiooutput' && d.deviceId
          && d.deviceId !== 'default' && d.deviceId !== 'communications',
      );
      // 名字全是空的那种名单等于没用（没拿到权限时浏览器就这么给），别当成「已就绪」
      if (!outs.length || !outs.some((d) => d.label)) return false;
      sink.list = outs;
      sink.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  /** 设备名归一：抹掉括号里的驱动后缀、空白和大小写差异。
   *  同一只喇叭，网页那边写 "CABLE Input (VB-Audio Virtual Cable)"，
   *  换个窗口可能只剩 "CABLE Input"，得认成同一只。 */
  function normLabel(text) {
    return String(text || '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /** 先按名字认（两边的 deviceId 不是一套），实在不行才退回 id。 */
  function pickSink(remote) {
    const label = remote.out_label || '';
    if (label) {
      const byName = sink.list.find((d) => d.label === label);
      if (byName) return byName;
      const want = normLabel(label);
      if (want) {
        const loose = sink.list.find((d) => normLabel(d.label) === want);
        if (loose) return loose;
        const near = sink.list.find((d) => {
          const n = normLabel(d.label);
          return n && (n.includes(want) || want.includes(n));
        });
        if (near) return near;
      }
    }
    if (remote.out_id) return sink.list.find((d) => d.deviceId === remote.out_id) || null;
    return null;
  }

  async function setSink(id) {
    if (!('setSinkId' in audio)) return false;
    try {
      await audio.setSinkId(id);
      return true;
    } catch (e) {
      status('bad', `换播放设备失败：${e.name || e.message}`);
      return false;
    }
  }

  async function applyOutput(remote) {
    const want = `${remote.out_id || ''}\u0000${remote.out_label || ''}`;
    if (want === sink.key) return;         // 设置没变就别折腾
    sink.key = want;

    if (!remote.out_id && !remote.out_label) {
      if (await setSink('')) markSink('系统默认');
      return;
    }

    if (!sink.ready) await loadOutputs();
    let hit = pickSink(remote);
    if (!hit) {
      // 浮窗刚起来那会儿，设备名单有时是残缺的；再拿一次就不一样了
      await loadOutputs();
      hit = pickSink(remote);
    }
    if (hit && await setSink(hit.deviceId)) {
      markSink(hit.label || '系统默认');
      return;
    }

    // 认不出来就老实待在默认设备上，并且说清楚——不然人还以为切过去了
    if (await setSink('')) {
      markSink('系统默认（没认出设置的设备）');
      status('bad', remote.out_label
        ? `没找到「${remote.out_label}」，声音先走系统默认`
        : '不知道网页里选的是哪只音箱，声音先走系统默认');
    }
  }

  /** 把落点写在页面上，同时报给服务端——设置面板里能直接看到浮窗究竟从哪出声。 */
  let reported = '';
  function markSink(label) {
    sink.applied = label || '系统默认';
    document.documentElement.dataset.sink = sink.applied;
    if (sink.applied === reported) return;
    reported = sink.applied;
    void push({ sink_applied: sink.applied });
  }

  async function ttsUrl(text) {
    const key = `${state.character.id}\u0000${text}`;
    const hit = state.cache.get(key);
    if (hit) return hit;
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character: state.character.id, text }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `语音合成失败（${res.status}）`);
    }
    const url = URL.createObjectURL(await res.blob());
    state.cache.set(key, url);
    if (state.cache.size > 40) {
      const [oldKey, oldUrl] = state.cache.entries().next().value;
      URL.revokeObjectURL(oldUrl);
      state.cache.delete(oldKey);
    }
    return url;
  }

  /** 一句一句排队：连着敲几行不会互相打断，也不会第二句掐掉第一句。 */
  async function pump() {
    if (state.pumping) return;
    state.pumping = true;
    while (state.queue.length) {
      const text = state.queue.shift();
      if (!state.character) continue;
      try {
        status('work');
        audio.src = await ttsUrl(text);
        await audio.play();
        status('ok');
      } catch (e) {
        status('bad', e.message);
      }
    }
    state.pumping = false;
  }

  /* ───────────── 状态 ───────────── */

  function status(kind, message) {
    const field = form;
    field.classList.toggle('is-work', kind === 'work');
    field.classList.toggle('is-ok', kind === 'ok');
    field.classList.toggle('is-bad', kind === 'bad');
    if (kind === 'bad' && message) {
      const msg = String(message).replace(/\s+/g, ' ').trim();
      input.placeholder = msg.length > 24 ? `${msg.slice(0, 24)}…` : msg;
    } else if (kind !== 'bad') {
      input.placeholder = HINT;
    }
    clearTimeout(state.timer);
    if (kind !== 'idle') {
      state.timer = setTimeout(() => status('idle'), kind === 'bad' ? 4200 : 2600);
    }
  }

  /* ───────────── 关窗 ───────────── */

  function close() {
    const api = window.pywebview && window.pywebview.api;
    if (api && typeof api.close === 'function') {
      Promise.resolve(api.close()).catch(() => {});
      return;
    }
    // 桥还没就绪时的退路：让服务端把这个进程收掉
    fetch('/api/float/close', { method: 'POST' }).catch(() => {});
  }

  /* ───────────── 事件 ───────────── */

  function bind() {
    // 头像就是下拉：原生列表由系统画，不受这个小窗口的高度限制
    pick.addEventListener('change', () => {
      const picked = state.characters.find((c) => c.id === pick.value);
      if (picked) use(picked);
      input.focus();
    });

    // 输入法正在处理这个键时，回车是「选词」，不该触发发送。
    // 判断要看这一次按键本身（isComposing / keyCode 229），不能自己维护一个开关：
    // 微软拼音确认候选后不一定发 compositionend，开关会一直卡在「输入中」，
    // 之后所有回车都被吞掉——这正是之前回车发不出去的原因。
    const imeBusy = (e) => e.isComposing || e.keyCode === 229;
    input.addEventListener('keydown', (e) => {
      if (imeBusy(e)) return;
      if (e.key !== 'Enter') return;
      e.preventDefault();
      form.requestSubmit();
    });

    // Esc 不关窗：打字时手滑按到就把浮窗关了太碍事，关窗只留右上角那个 × 。
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !state.character) return;
      input.value = '';
      input.focus();
      state.queue.push(text);
      void pump();
    });

    $('x').addEventListener('click', close);

    // 光标留在输入框里：玩游戏时点一下窗口就能接着敲，不用先瞄准输入框
    document.addEventListener('pointerdown', (e) => {
      if (e.target === input || e.target === pick || e.target === ava) return;
      if (e.target.closest('.x, .send, .grip')) return;
      setTimeout(() => input.focus(), 0);
    });
    window.addEventListener('focus', () => {
      // 延后一拍：正在点头像换人时别把焦点抢回来，否则下拉打不开
      setTimeout(() => {
        if (document.activeElement !== pick) input.focus();
      }, 0);
    });
  }

  /* ───────────── 起 ───────────── */

  async function boot() {
    bind();
    try {
      const data = await fetch('/api/characters').then((r) => r.json());
      state.characters = data.characters || [];
      state.units = data.units || [];
    } catch {
      status('bad', '连不上本地服务，检查那个黑窗口还开着吗');
      return;
    }
    buildRoster();

    const fromUrl = new URLSearchParams(location.search).get('c') || '';
    const server = await pull();
    let remembered = '';
    try { remembered = localStorage.getItem('echo.floatChar') || ''; } catch { /* 隐私模式 */ }

    const wanted = fromUrl || server.character || remembered;
    const start = state.characters.find((c) => c.id === wanted) || state.characters[0];
    if (start) use(start, false);

    status('idle');
    input.focus();
    void applyOutput(server);        // 声音从网页里选的那只扬声器出来

    // 网页那边换了人，浮窗跟着换（两边写的是同一个状态，不会来回打架）；
    // 顺手看一眼快捷键有没有注册上、播放设备有没有变。
    let griped = '';
    setInterval(async () => {
      const s = await pull();
      if (typeof s.hotkey_error === 'string' && s.hotkey_error !== griped) {
        griped = s.hotkey_error;
        if (griped) status('bad', griped);
      }
      void applyOutput(s);
      if (!s.character || s.character === state.seen) return;
      const c = state.characters.find((x) => x.id === s.character);
      if (c) use(c, false);
    }, 1500);
  }

  void boot();
})();
