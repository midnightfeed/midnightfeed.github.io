/* Shared behaviour for Archive pages (the home page carries its own script). */
(function () {
  "use strict";

  /* ---------------- Share on X ---------------- */
  var SITE = "https://midnightfeed.net";
  Array.prototype.forEach.call(document.querySelectorAll("[data-share-text]"), function (a) {
    a.setAttribute("href", "https://x.com/intent/post?text=" + encodeURIComponent(a.getAttribute("data-share-text")) +
      "&url=" + encodeURIComponent(a.getAttribute("data-share-url") || SITE) + "&via=midnightfeeders");
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
  });

  /* ---------------- next rebuild countdown (midnight Central) ---------------- */
  var BUILT_FOR = null;
  function chicagoDay(d) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(d);
  }
  var live = document.querySelector(".utility .live");
  function tick() {
    if (!live || !window.Intl) { return; }
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    var h = 0, m = 0;
    parts.forEach(function (p) { if (p.type === "hour") { h = +p.value; } if (p.type === "minute") { m = +p.value; } });
    var left = 1440 - (h * 60 + m);
    var label = "Night Wire rebuilt 00:00 CT";
    if (BUILT_FOR && BUILT_FOR !== chicagoDay(new Date())) {
      var bd = new Date(BUILT_FOR + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
      label = "Night Wire last rebuilt " + bd;
    }
    live.innerHTML = '<span class="dot"></span> ' + label + ' &middot; next in ' + Math.floor(left / 60) + "h " + (left % 60) + "m";
  }
  tick();
  setInterval(tick, 30000);
  if (window.fetch) {
    fetch("/data/wire.json", { cache: "no-cache" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.built_for) { BUILT_FOR = d.built_for; tick(); }
    }).catch(function () {});
  }

  /* ---------------- Archive covers (verified only) ---------------- */
  if (window.fetch && document.querySelector(".cover[data-cover]")) {
    fetch("/assets/covers/manifest.json", { cache: "no-cache" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      if (!m) { return; }
      Array.prototype.forEach.call(document.querySelectorAll(".cover[data-cover]"), function (plate) {
        var c = m[plate.getAttribute("data-cover")];
        if (!c || !c.verified || !c.file) { return; }
        var img = new Image();
        img.alt = "Cover of " + c.title + " (" + c.imprint + ")";
        img.loading = "lazy";
        img.onload = function () { plate.classList.add("has-img"); };
        img.onerror = function () { img.remove(); };
        img.src = "/assets/covers/" + c.file;
        plate.appendChild(img);
      });
    }).catch(function () { /* keep the plates */ });
  }
})();
