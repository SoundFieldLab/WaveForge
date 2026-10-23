'use strict';

// Spotify 授权窗常驻关闭按钮（preload，2026-10-21）。
//
// 背景：无框（frame:false）授权窗的关闭按钮此前在主进程 did-finish-load 里
// executeJavaScript 注入。Spotify 授权页是重 SPA，首次 finish-load 要等它把
// CDN 资源全拉完（网络一般时 1 分钟+），期间用户没有任何关闭入口。
//
// preload 在**每个**页面的 DOM 建立之前执行（contextIsolation 开启，无 Node 权限泄露），
// 与页面加载快慢完全无关：
//   · DOM 就绪即挂按钮（DOMContentLoaded / 已就绪立即挂）；
//   · Spotify 授权流程会多次整页跳转（登录 → 同意 → 回调页），每次跳转 preload
//     重新执行，按钮天然"常驻"；
//   · Spotify 页面自身的全局脚本可能重写 body（React 挂载清空子节点），这里用
//     MutationObserver 监听 body 子树移除，按钮被清掉就立刻补回。

(function installCloseButton() {
  if (window.__waveforgeSpotifyCloseInstalled) return;
  window.__waveforgeSpotifyCloseInstalled = true;

  var BUTTON_ID = 'waveforge-close-btn';

  function mount() {
    if (document.getElementById(BUTTON_ID)) return true;
    var host = document.body;
    if (!host) return false;
    var b = document.createElement('div');
    b.id = BUTTON_ID;
    b.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">'
      + '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    b.style.cssText = 'position:fixed;top:12px;right:12px;width:32px;height:32px;'
      + 'background:rgba(0,0,0,0.55);border-radius:50%;display:flex;align-items:center;'
      + 'justify-content:center;cursor:pointer;z-index:2147483647;color:#fff;';
    b.addEventListener('click', function () { window.close(); });
    host.appendChild(b);
    return true;
  }

  if (!mount()) {
    // body 还没建（preload 在文档开头跑）：DOMContentLoaded 后补挂
    document.addEventListener('DOMContentLoaded', mount, { once: true });
    window.addEventListener('load', mount, { once: true });
  }

  // React/Vue 挂载会整树清空 body：按钮被移除时立即补回（幂等）
  var observer = new MutationObserver(function () {
    if (!document.getElementById(BUTTON_ID)) mount();
  });
  var startObserving = function () {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: false });
      mount();
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        observer.observe(document.body, { childList: true, subtree: false });
        mount();
      }, { once: true });
    }
  };
  startObserving();
})();
