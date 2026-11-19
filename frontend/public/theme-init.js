/* global localStorage, sessionStorage, navigator, window, document */
(function(){var t=localStorage.getItem('klipgard-theme')||'auto';if(t==='auto')t=window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark';document.documentElement.setAttribute('data-theme',t)})();
/* WEB-PUBLIC-112: the public bar logo plays its focus motion on the first public page of a
   browser session. Decided here, before the first paint; the bar records the session on mount.
   The prerender saves <html> with its attributes, so the attribute is also removed explicitly. */
(function(){var r=document.documentElement;try{if(!navigator.webdriver&&!sessionStorage.getItem('klipgard-logo-focus')){r.setAttribute('data-logo-focus','1');return}}catch{/* blocked storage: no motion */}r.removeAttribute('data-logo-focus')})();
