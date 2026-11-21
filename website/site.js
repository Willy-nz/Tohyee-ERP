/* Progressive enhancement: without JS the menu, every product screen and the FAQ still work. */
document.documentElement.classList.replace("no-js", "js");

// Header hairline: shown only once content scrolls under the translucent header.
const header = document.querySelector(".site-header");
if (header) {
  let ticking = false;
  const update = () => {
    header.classList.toggle("is-scrolled", window.scrollY > 4);
    ticking = false;
  };
  window.addEventListener(
    "scroll",
    () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    },
    { passive: true },
  );
  update();
}

// Menu (narrow screens).
const menu = document.querySelector(".menu-toggle");
const navigation = document.querySelector(".site-nav");
if (menu && navigation) {
  const setOpen = (open) => {
    menu.setAttribute("aria-expanded", String(open));
    navigation.classList.toggle("is-open", open);
  };
  menu.addEventListener("click", () => setOpen(menu.getAttribute("aria-expanded") !== "true"));
  navigation.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      menu.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".site-header")) setOpen(false);
  });
  // Close it if the window grows past the menu breakpoint.
  matchMedia("(min-width: 861px)").addEventListener("change", (e) => e.matches && setOpen(false));
}

// Segmented control. The thumb slides with a CSS transition on transform, which
// starts from wherever it is on screen, so a quick second tap redirects it smoothly.
document.querySelectorAll('[role="tablist"]').forEach((list) => {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const thumb = list.querySelector(".thumb");

  function placeThumb(tab, animate) {
    if (!thumb) return;
    if (!animate) thumb.style.transition = "none";
    thumb.style.width = `${tab.offsetWidth}px`;
    thumb.style.transform = `translateX(${tab.offsetLeft}px)`;
    if (!animate) {
      thumb.getBoundingClientRect();
      thumb.style.transition = "";
    }
  }

  function select(selected, animate = true) {
    tabs.forEach((tab) => {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      panel.classList.toggle("is-active", active);
      panel.inert = !active;
      panel.setAttribute("aria-hidden", String(!active));
      if (active) panel.querySelectorAll("img").forEach((img) => (img.loading = "eager"));
    });
    placeThumb(selected, animate);
  }

  // Respond on press, not on release.
  tabs.forEach((tab, index) => {
    tab.addEventListener("pointerdown", (event) => {
      if (event.button === 0) select(tab);
    });
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      select(tabs[next]);
      tabs[next].focus();
    });
  });

  const current = () => tabs.find((tab) => tab.getAttribute("aria-selected") === "true") || tabs[0];
  select(current(), false);
  // Re-measure when fonts load or the text size changes.
  if (document.fonts) document.fonts.ready.then(() => placeThumb(current(), false));
  new ResizeObserver(() => placeThumb(current(), false)).observe(list);
});
