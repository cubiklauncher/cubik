// Cubik 官网交互脚本
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- 导航滚动状态 ----------
  var nav = document.getElementById('nav');
  function onScroll() {
    if (!nav) return;
    if (window.scrollY > 24) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---------- 滚动进场 ----------
  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e, i) {
        if (e.isIntersecting) {
          var el = e.target;
          var delay = (el.dataset.delay ? parseInt(el.dataset.delay, 10) : 0);
          setTimeout(function () { el.classList.add('in'); }, delay);
          io.unobserve(el);
        }
      });
    }, { threshold: 0.14, rootMargin: '0px 0px -40px 0px' });

    // 同组元素错峰
    document.querySelectorAll('.feat-grid, .dl-grid, .faq-list').forEach(function (group) {
      Array.prototype.slice.call(group.children).forEach(function (child, idx) {
        if (child.classList.contains('reveal') && !child.dataset.delay) {
          child.dataset.delay = String(Math.min(idx * 70, 420));
        }
      });
    });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  // ---------- 卡片光斑跟随 ----------
  document.querySelectorAll('.feat-card').forEach(function (card) {
    card.addEventListener('mousemove', function (ev) {
      var r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (ev.clientX - r.left) + 'px');
      card.style.setProperty('--my', (ev.clientY - r.top) + 'px');
    });
  });

  // ---------- 使用统计（匿名上报聚合，公开展示） ----------
  // 后端不可达时优雅降级：显示“暂时无法获取”而不是留一堆 “—”，
  // 避免访问者误以为网站坏了。
  var STATS_API = 'https://cubik-telemetry.358670473.workers.dev';
  (function loadStats() {
    var section = document.getElementById('stats');
    var elL = document.getElementById('statLaunches');
    var elD = document.getElementById('statDevices');
    var elT = document.getElementById('statToday');
    var note = document.getElementById('statNote');
    if (!elL || !STATS_API || STATS_API.indexOf('example.com') !== -1) {
      if (section) section.style.display = 'none';
      return;
    }
    var done = false;
    var showUnavailable = function () {
      if (done) return;
      done = true;
      var grid = document.getElementById('statsGrid');
      if (grid) grid.style.display = 'none';
      if (note) note.textContent = '统计数据暂时无法获取（稍后会自动重试）。此功能不影响启动器使用。';
    };
    // 8 秒超时保护（含国内网络对 workers.dev 不可达的情形）
    var timer = setTimeout(showUnavailable, 8000);
    fetch(STATS_API.replace(/\/$/, '') + '/stats')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (d) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        elL.textContent = Number(d.total_launches || 0).toLocaleString('zh-CN');
        elD.textContent = Number(d.total_devices || 0).toLocaleString('zh-CN');
        elT.textContent = Number(d.today_active || 0).toLocaleString('zh-CN');
        if (note) note.textContent = '数据实时更新 · 仅统计匿名总量，不涉及个人隐私';
      })
      .catch(function () { clearTimeout(timer); showUnavailable(); });
  })();

  // ---------- 背景粒子（轻量 canvas） ----------
  var canvas = document.getElementById('bg-canvas');
  if (!canvas || reduceMotion) return;
  var ctx = canvas.getContext('2d');
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var w = 0, h = 0, particles = [], raf = null;

  function resize() {
    w = canvas.width = Math.floor(window.innerWidth * dpr);
    h = canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    var target = window.innerWidth < 768 ? 46 : 90;
    if (particles.length !== target) seed(target);
  }

  function seed(n) {
    particles = [];
    for (var i = 0; i < n; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22 * dpr,
        vy: (Math.random() - 0.5) * 0.22 * dpr,
        r: (Math.random() * 1.6 + 0.6) * dpr,
        a: Math.random() * 0.5 + 0.2
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120,200,255,' + p.a + ')';
      ctx.fill();
    }
    // 连线
    for (var j = 0; j < particles.length; j++) {
      for (var k = j + 1; k < particles.length; k++) {
        var dx = particles[j].x - particles[k].x;
        var dy = particles[j].y - particles[k].y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var maxD = 130 * dpr;
        if (dist < maxD) {
          ctx.beginPath();
          ctx.moveTo(particles[j].x, particles[j].y);
          ctx.lineTo(particles[k].x, particles[k].y);
          ctx.strokeStyle = 'rgba(90,150,255,' + (0.12 * (1 - dist / maxD)) + ')';
          ctx.lineWidth = dpr * 0.8;
          ctx.stroke();
        }
      }
    }
    raf = requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize, { passive: true });
  resize();
  draw();

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = null; }
    else if (!raf) { draw(); }
  });
})();
