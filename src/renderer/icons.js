// 图标库：内联 SVG 图标（离线可用，stroke 风格），替代界面中的 emoji
// 用法：icon('home') 或 icon('home', { size: 20, className: 'x' })
(function (global) {
  // 统一 stroke 风格参数
  const strokeAttrs = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

  // 图标路径数据（viewBox 0 0 24 24）
  const PATHS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-6h5v6"/>',
    box: '<path d="M12 3l7 4v10l-7 4-7-4V7z"/><path d="M5 7l7 4 7-4"/><path d="M12 11v10"/>',
    puzzle: '<path d="M10 4a2 2 0 0 1 4 0c0 1.5.5 2 2 2h3v3c0 1.5.5 2 2 2a2 2 0 0 1 0 4c-1.5 0-2 .5-2 2v3h-4"/><path d="M3 6h4v5a2.5 2.5 0 0 0 5 0V6h3a2 2 0 0 1 2 2v2"/><path d="M9 20h3"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4L15 12l-3-3z"/>',
    sparkles: '<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/><path d="M18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/><path d="M5.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01"/><path d="M7 16.5h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.3 3.6-5.5 8-5.5s8 2.2 8 5.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="M4.9 4.9l2.1 2.1"/><path d="M17 17l2.1 2.1"/><path d="M19.1 4.9L17 7"/><path d="M7 17l-2.1 2.1"/>',
    scroll: '<path d="M7 3h9a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6"/><path d="M6 3a1.5 1.5 0 0 0 0 3h10"/><path d="M9 12h6"/><path d="M9 16h4"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>',
    recycle: '<path d="M12 4l2 3.5H8L6.5 5.5"/><path d="M12 4v4"/><path d="M6.5 12l2 3.5H5L3.5 13.5"/><path d="M19 13.5l-2-3.5h-3.5L15 13.5"/><path d="M12 20l-2-3.5h4L15.5 20"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    download: '<path d="M12 3v11"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 3.8 5.6 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.6-3.8-9S9.5 5.5 12 3z"/>',
    warning: '<path d="M12 3 2 20h20z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h14v17H6a2 2 0 0 0-2 2z"/><path d="M4 19a2 2 0 0 0 2 2h14V5"/>',
    save: '<path d="M4 3h13l3 3v15H4z"/><path d="M8 3v6h7V3"/><path d="M8 20v-6h8v6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    flame: '<path d="M12 3c1 3-2 4-2 7a3.5 3.5 0 0 0 7 1c.5 2-1 3.5-2 4a5 5 0 1 1-6-7c0-1.5 1-2 3-5z"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H12a5 5 0 0 1 0-10z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/>',
    check: '<path d="M4 12.5l5 5L20 6.5"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    plug: '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',
    file: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h6"/><path d="M9 16h6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    game: '<path d="M6 11h4M8 9v4"/><circle cx="15.5" cy="10.5" r=".5"/><circle cx="17.5" cy="13.5" r=".5"/><path d="M7 5h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M3 17l5-5 4 4 3-3 6 6"/>',
    edit: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    moon: '<path d="M20 13A8 8 0 1 1 11 4a6.5 6.5 0 0 0 9 9z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M19.1 4.9l-1.4 1.4"/><path d="M6.3 17.7l-1.4 1.4"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3 2.7-4.5 6-4.5s6 1.5 6 4.5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 15.5c2.5 0 4.5 1 4.5 3.5"/>',
    chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    play: '<path d="M7 4l12 8-12 8z"/>',
    upload: '<path d="M12 15V4"/><path d="M7 9l5-5 5 5"/><path d="M4 19h16"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M17 6l2 2"/><path d="M14 9l2 2"/>',
    map: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15"/><path d="M15 6v15"/>',
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    bolt: '<path d="M13 2L5 13h6l-1 9 8-11h-6z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>',
    cube: '<path d="M12 3l7 4v10l-7 4-7-4V7z"/><path d="M5 7l7 4 7-4"/><path d="M12 11v10"/>',
    cup: '<path d="M5 9h11v6a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5z"/><path d="M16 10h1a3 3 0 0 1 0 6h-1"/><path d="M7 5c0-1 1-2 2-2h6c1 0 2 1 2 2"/>',
    heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
    sword: '<path d="M15 4l5 5-8 8-5-5z"/><path d="M9 4l-5 5"/><path d="M5 14l-2 2v3h3l2-2"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    cloud: '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A4 4 0 0 1 17 18z"/>',
    'cloud-rain': '<path d="M7 16a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A4 4 0 0 1 17 16z"/><path d="M8 20h.01"/><path d="M12 20h.01"/><path d="M16 20h.01"/>',
    'cloud-lightning': '<path d="M7 16a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A4 4 0 0 1 17 16z"/><path d="M12 15l-3 5h4l-1 4"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01"/><path d="M15 9.5h.01"/>',
    skull: '<path d="M12 3a7 7 0 0 0-7 7v3l2 2v4h10v-4l2-2v-3a7 7 0 0 0-7-7z"/><circle cx="9" cy="11" r="1.2"/><circle cx="15" cy="11" r="1.2"/><path d="M10 18h4"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h6a3 3 0 0 0 0-6H10a3 3 0 0 1 0-6h6"/>'
  };

  // 生成内联 SVG 字符串
  function icon(name, opts) {
    opts = opts || {};
    const size = opts.size != null ? opts.size : 18;
    const cls = opts.className ? ' class="' + opts.className + '"' : '';
    const title = opts.title ? '<title>' + opts.title + '</title>' : '';
    const inner = PATHS[name];
    if (!inner) return '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + size + '" height="' + size + '"' + cls + ' aria-hidden="true"' + strokeAttrs + '>' + title + inner + '</svg>';
  }

  global.icon = icon;

  // 统一初始化：把页面里带 data-icon 的元素替换成对应 SVG
  function initIcons(root) {
    root = root || document;
    root.querySelectorAll('[data-icon]').forEach((el) => {
      const name = el.getAttribute('data-icon');
      if (!name) return;
      const size = el.getAttribute('data-icon-size');
      el.innerHTML = icon(name, { size: size ? parseInt(size, 10) : 18 });
      el.classList.add('ico');
    });
  }
  global.__initIcons = initIcons;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => initIcons());
    } else {
      initIcons();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
