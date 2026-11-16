/**
 * DealersOrbit — Dealership tab
 * ─────────────────────────────
 * Desk lookup + car detail (facts, links, AI talking points, alternatives) for a
 * dealership's whole inventory. Backed by the dormant step-2 endpoints:
 *   GET  /dealership/inventory            (search)
 *   GET  /dealership/inventory/{id}       (one car)
 *   PUT  /dealership/inventory/{id}/specs (push captured VDP specs)
 *   GET  /dealership/inventory/{id}/highlights
 *   GET  /dealership/inventory/{id}/alternatives
 *
 * Loaded BEFORE popup.js, so every reference to popup.js globals (apiFetch,
 * API_BASE, showScreen, dashboardScreen, renderQueue, vehicleTitle) is made from
 * inside functions that only run after popup.js has finished loading (init()).
 *
 * The backend require_dealership_member gate is authoritative; the UI unlock
 * (user.purchased_plan === 'dealership') is UX only — same rule as the sync button.
 */

let dlrSearchTimer = null;
let dlrSetupDone = false;

// ── Setup (called once from popup.js init) ────────────────────
function dlrSetup() {
  if (dlrSetupDone) return;
  dlrSetupDone = true;

  document.getElementById("tabListings")?.addEventListener("click", () => dlrSwitchTab("dashboard"));
  document.getElementById("tabDealership")?.addEventListener("click", () => dlrSwitchTab("dealership"));

  document.getElementById("dlrBackToSearch")?.addEventListener("click", () => dlrShowSearchView());

  const search = document.getElementById("dlrSearch");
  search?.addEventListener("input", () => {
    if (dlrSearchTimer) clearTimeout(dlrSearchTimer);
    dlrSearchTimer = setTimeout(() => dlrSearch(search.value.trim()), 300);
  });

  // Highlights-language toggle in Settings (bound once).
  document.querySelectorAll(".hl-lang-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lang = btn.dataset.hllang === "es" ? "es" : "en";
      dlrUpdateHlLangUI(lang);
      const { token } = await chrome.storage.local.get("token");
      if (!token) return;
      try {
        const resp = await apiFetch(`${API_BASE}/auth/me`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ highlights_language: lang }),
        });
        if (resp.ok) {
          // PATCH /auth/me returns the RAW row (own purchased_plan/status), NOT the
          // effective overlay that GET /auth/me returns. Storing it wholesale would
          // blank an inheriting rep's effective plan and lock this tab. Merge only
          // the field we changed; the cached user keeps its effective plan.
          const { user: cur } = await chrome.storage.local.get("user");
          await chrome.storage.local.set({ user: { ...(cur || {}), highlights_language: lang } });
        } else {
          alert("Failed to save talking-point language. Please try again.");
        }
      } catch (e) {
        alert("Failed to save talking-point language. Please try again.");
      }
    });
  });
}

// ── Initial tab (called after login / on popup open) ──────────
// Dealership-plan users land on the Dealership tab the first time; after that the
// panel remembers the last tab used.
async function dlrApplyInitialTab(user) {
  const isDealer = user?.purchased_plan === "dealership";
  const { last_main_tab, dealership_tab_seen } =
    await chrome.storage.local.get(["last_main_tab", "dealership_tab_seen"]);

  let tab = "dashboard";
  if (isDealer && !dealership_tab_seen) {
    tab = "dealership";
    await chrome.storage.local.set({ dealership_tab_seen: true });
  } else if (last_main_tab === "dealership") {
    tab = "dealership";
  }
  await dlrSwitchTab(tab);
}

// Return to whichever main tab the user last had open (used by Settings/Help back).
async function dlrGoHome() {
  const { last_main_tab } = await chrome.storage.local.get("last_main_tab");
  await dlrSwitchTab(last_main_tab === "dealership" ? "dealership" : "dashboard");
}

// ── Tab switching ─────────────────────────────────────────────
async function dlrSwitchTab(tab) {
  await chrome.storage.local.set({ last_main_tab: tab });
  if (tab === "dealership") {
    showScreen(document.getElementById("dealershipScreen"));
    await dlrRenderTab();
  } else {
    showScreen(dashboardScreen);
    renderQueue();
  }
}

// Show locked vs. main content based on the cached (effective) plan.
async function dlrRenderTab() {
  const { user } = await chrome.storage.local.get("user");
  const isDealer = user?.purchased_plan === "dealership";
  const locked = document.getElementById("dlrLocked");
  const main = document.getElementById("dlrMain");
  if (!isDealer) {
    if (locked) locked.style.display = "block";
    if (main) main.style.display = "none";
    return;
  }
  if (locked) locked.style.display = "none";
  if (main) main.style.display = "block";
  dlrShowSearchView();
  const input = document.getElementById("dlrSearch");
  dlrSearch(input?.value?.trim() || "");
}

function dlrShowLocked() {
  const locked = document.getElementById("dlrLocked");
  const main = document.getElementById("dlrMain");
  if (locked) locked.style.display = "block";
  if (main) main.style.display = "none";
}
function dlrShowSearchView() {
  const sv = document.getElementById("dlrSearchView");
  const dv = document.getElementById("dlrDetailView");
  if (sv) sv.style.display = "block";
  if (dv) dv.style.display = "none";
}
function dlrShowDetailView() {
  const sv = document.getElementById("dlrSearchView");
  const dv = document.getElementById("dlrDetailView");
  if (sv) sv.style.display = "none";
  if (dv) dv.style.display = "block";
}

// ── Settings: highlights-language section ─────────────────────
async function dlrRefreshSettingsSection() {
  const section = document.getElementById("dlrSettingsSection");
  if (!section) return;
  const { user } = await chrome.storage.local.get("user");
  const isDealer = user?.purchased_plan === "dealership";
  section.style.display = isDealer ? "block" : "none";
  dlrUpdateHlLangUI(user?.highlights_language === "es" ? "es" : "en");
}
function dlrUpdateHlLangUI(lang) {
  document.querySelectorAll(".hl-lang-btn").forEach((b) => {
    const sel = b.dataset.hllang === lang;
    b.classList.toggle("selected", sel);
    b.style.borderColor = sel ? "#1a56db" : "#e5e7eb";
    b.style.background = sel ? "#eff6ff" : "white";
    b.style.color = sel ? "#1a56db" : "#374151";
  });
}

// ── Helpers ───────────────────────────────────────────────────
// popup.js's apiFetch does NOT auto-inject the auth token (callers must pass it)
// and throws + logs out on 401. Wrap it so every dealership call carries the token.
async function dlrApi(url, options = {}) {
  const { token } = await chrome.storage.local.get("token");
  const headers = { ...(options.headers || {}) };
  if (token && !headers["Authorization"]) headers["Authorization"] = `Bearer ${token}`;
  return apiFetch(url, { ...options, headers });
}

function dlrEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function dlrFirstPhoto(car) {
  try {
    const arr = typeof car.photo_urls === "string" ? JSON.parse(car.photo_urls) : car.photo_urls;
    if (Array.isArray(arr) && arr.length) return arr[0];
  } catch (e) {}
  return null;
}
function dlrPrice(n) {
  if (n == null || n === "") return "";
  const v = parseInt(String(n).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(v) ? "$" + v.toLocaleString() : "";
}
function dlrTitle(car) {
  if (typeof vehicleTitle === "function") return vehicleTitle(car);
  return [car.year, car.make, car.model, car.trim].filter(Boolean).join(" ");
}

// ── Desk lookup ───────────────────────────────────────────────
async function dlrSearch(q) {
  const box = document.getElementById("dlrResults");
  if (!box) return;
  box.innerHTML = '<div class="dlr-muted">Loading…</div>';
  try {
    let url = `${API_BASE}/dealership/inventory?limit=25`;
    if (q) url += `&q=${encodeURIComponent(q)}`;
    const resp = await dlrApi(url, {});
    // Backend gate rejected (plan not/no-longer a Dealership plan) → show locked.
    // Flip the view directly; do NOT call dlrRenderTab (it re-runs dlrSearch → loop).
    if (resp.status === 403) { dlrShowLocked(); return; }
    if (!resp.ok) { box.innerHTML = '<div class="dlr-muted">Couldn\'t load inventory.</div>'; return; }
    const data = await resp.json();
    dlrRenderResults(data.items || [], data.total || 0, q);
  } catch (e) {
    box.innerHTML = '<div class="dlr-muted">Couldn\'t load inventory.</div>';
  }
}

function dlrRenderResults(items, total, q) {
  const box = document.getElementById("dlrResults");
  if (!box) return;
  if (!items.length) {
    box.innerHTML = `<div class="dlr-muted">${q ? "No matching vehicles." : "No inventory yet."}</div>`;
    return;
  }
  box.innerHTML = items.map((it) => {
    const photo = dlrFirstPhoto(it);
    const thumb = photo
      ? `<img class="dlr-thumb" src="${dlrEsc(photo)}" loading="lazy">`
      : `<div class="dlr-thumb dlr-thumb-empty">🚗</div>`;
    const sub = [
      it.stock_number ? `#${dlrEsc(it.stock_number)}` : "",
      it.condition ? dlrEsc(it.condition) : "",
      it.mileage ? `${Number(it.mileage).toLocaleString()} mi` : "",
    ].filter(Boolean).join(" · ");
    return `
      <div class="dlr-card" data-id="${it.id}">
        ${thumb}
        <div class="dlr-card-body">
          <div class="dlr-card-title">${dlrEsc(dlrTitle(it))}</div>
          <div class="dlr-card-sub">${sub}</div>
        </div>
        <div class="dlr-card-price">${dlrEsc(dlrPrice(it.price))}</div>
      </div>`;
  }).join("");
  if (total > items.length) {
    box.insertAdjacentHTML("beforeend",
      `<div class="dlr-muted dlr-more">Showing ${items.length} of ${total}. Refine your search to narrow.</div>`);
  }
  box.querySelectorAll(".dlr-card").forEach((el) => {
    el.addEventListener("click", () => dlrOpenCar(parseInt(el.dataset.id, 10)));
  });
}

// ── Car detail ────────────────────────────────────────────────
async function dlrOpenCar(id) {
  dlrShowDetailView();
  const detail = document.getElementById("dlrDetail");
  if (detail) detail.innerHTML = '<div class="dlr-muted">Loading…</div>';
  let car;
  try {
    const resp = await dlrApi(`${API_BASE}/dealership/inventory/${id}`, {});
    if (!resp.ok) { if (detail) detail.innerHTML = '<div class="dlr-muted">Couldn\'t load this vehicle.</div>'; return; }
    car = await resp.json();
  } catch (e) {
    if (detail) detail.innerHTML = '<div class="dlr-muted">Couldn\'t load this vehicle.</div>';
    return;
  }

  // Auto-capture the VDP specs the first time this car is opened (no specs yet).
  let capturing = false;
  if (!car.specs_source && car.listing_url) capturing = true;
  dlrRenderDetail(car, { capturing });

  if (capturing) {
    const updated = await dlrCaptureSpecs(car);
    if (updated) car = updated;
    dlrRenderDetail(car, { capturing: false });
  }

  dlrLoadHighlights(car);
  dlrLoadAlternatives(car.id);
}

// Capture VDP specs via the background tab, PUT them, return the updated row (or null).
async function dlrCaptureSpecs(car) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_VDP_SPECS", listing_url: car.listing_url });
    if (!res?.success || !res.specs) return null;
    const s = res.specs;
    // Lift a few scalar fields out of the spec table so the facts grid fills in
    // (the backend merges these non-null-wins, same rule as sync).
    const st = s.spec_table || {};
    const pick = (...keys) => { for (const k of keys) if (st[k]) return st[k]; return null; };
    const body = {
      source_page_url: res.source_page_url || car.listing_url,
      spec_table: st,
      highlights: s.highlights || [],
      packages: s.packages || [],
      window_sticker_url: s.window_sticker_url || null,
      carfax_url: s.carfax_url || null,
      exterior_color: pick("Exterior Color", "Exterior"),
      interior_color: pick("Interior Color", "Interior"),
      stock_number: pick("Stock Number", "Stock #", "Stock"),
    };
    const resp = await dlrApi(`${API_BASE}/dealership/inventory/${car.id}/specs`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    return null;
  }
}

function dlrRenderDetail(car, opts) {
  const detail = document.getElementById("dlrDetail");
  if (!detail) return;
  const photo = dlrFirstPhoto(car);
  const hero = photo
    ? `<img class="dlr-hero" src="${dlrEsc(photo)}">`
    : `<div class="dlr-hero dlr-hero-empty">🚗</div>`;

  // Facts grid
  const facts = [];
  const push = (label, val) => { if (val != null && val !== "") facts.push([label, val]); };
  push("Price", dlrPrice(car.price));
  push("Mileage", car.mileage ? Number(car.mileage).toLocaleString() + " mi" : "");
  push("Condition", car.condition);
  push("Stock #", car.stock_number);
  push("VIN", car.vin);
  push("Exterior", car.exterior_color);
  push("Interior", car.interior_color);
  push("Drivetrain", car.drivetrain);
  push("Engine", car.engine);
  const factsHtml = facts.map(([l, v]) =>
    `<div class="dlr-fact"><span class="dlr-fact-l">${dlrEsc(l)}</span><span class="dlr-fact-v">${dlrEsc(v)}</span></div>`
  ).join("");

  // Links
  const links = [];
  if (car.listing_url) links.push(`<a class="dlr-link" href="${dlrEsc(car.listing_url)}" target="_blank">View listing ↗</a>`);
  if (car.carfax_url) links.push(`<a class="dlr-link" href="${dlrEsc(car.carfax_url)}" target="_blank">Carfax ↗</a>`);
  let stickerUrl = null;
  try {
    const sj = typeof car.specs_json === "string" ? JSON.parse(car.specs_json) : car.specs_json;
    if (sj && sj.window_sticker_url) stickerUrl = sj.window_sticker_url;
  } catch (e) {}
  if (stickerUrl) links.push(`<a class="dlr-link" href="${dlrEsc(stickerUrl)}" target="_blank">Window sticker ↗</a>`);
  const linksHtml = links.length ? `<div class="dlr-links">${links.join("")}</div>` : "";

  const capturing = opts && opts.capturing;
  const refreshLabel = capturing ? "Loading full specs…" : "Refresh specs";

  detail.innerHTML = `
    ${hero}
    <div class="dlr-detail-title">${dlrEsc(dlrTitle(car))}</div>
    ${linksHtml}
    <div class="dlr-facts">${factsHtml}</div>

    <div class="dlr-section-head">
      <span>Talking points</span>
      <button class="dlr-refresh-btn" id="dlrRefreshSpecs" ${capturing ? "disabled" : ""}>${refreshLabel}</button>
    </div>
    <div id="dlrHighlights" class="dlr-highlights">
      ${capturing ? '<div class="dlr-muted">Loading full specs…</div>' : '<div class="dlr-muted">Generating talking points…</div>'}
    </div>

    <div class="dlr-section-head"><span>Similar vehicles</span></div>
    <div id="dlrAlternatives" class="dlr-alts"><div class="dlr-muted">Loading…</div></div>
  `;

  document.getElementById("dlrRefreshSpecs")?.addEventListener("click", async () => {
    const btn = document.getElementById("dlrRefreshSpecs");
    if (btn) { btn.disabled = true; btn.textContent = "Loading full specs…"; }
    const box = document.getElementById("dlrHighlights");
    if (box) box.innerHTML = '<div class="dlr-muted">Loading full specs…</div>';
    const updated = await dlrCaptureSpecs(car);
    const fresh = updated || car;
    dlrRenderDetail(fresh, { capturing: false });
    dlrLoadHighlights(fresh);
    dlrLoadAlternatives(fresh.id);
  });
}

async function dlrLoadHighlights(car) {
  const box = document.getElementById("dlrHighlights");
  if (!box) return;
  box.innerHTML = '<div class="dlr-muted">Generating talking points…</div>';
  try {
    const resp = await dlrApi(`${API_BASE}/dealership/inventory/${car.id}/highlights`, {});
    if (resp.status === 502) { box.innerHTML = '<div class="dlr-muted">Talking points are unavailable right now. Try again shortly.</div>'; return; }
    if (!resp.ok) { box.innerHTML = '<div class="dlr-muted">Couldn\'t load talking points.</div>'; return; }
    const data = await resp.json();
    const hls = data.highlights || [];
    if (!hls.length) { box.innerHTML = '<div class="dlr-muted">No talking points.</div>'; return; }
    box.innerHTML = hls.map((h) => `
      <div class="dlr-hl">
        <div class="dlr-hl-title">${dlrEsc(h.title)}${h.verify ? ' <span class="dlr-verify">verify on the sticker</span>' : ""}</div>
        <div class="dlr-hl-detail">${dlrEsc(h.detail)}</div>
      </div>`).join("");
    if (data.data_quality === "basic") {
      box.insertAdjacentHTML("beforeend",
        '<div class="dlr-muted dlr-basic">Based on basic info — tap “Refresh specs” for fuller talking points.</div>');
    }
  } catch (e) {
    box.innerHTML = '<div class="dlr-muted">Couldn\'t load talking points.</div>';
  }
}

async function dlrLoadAlternatives(id) {
  const box = document.getElementById("dlrAlternatives");
  if (!box) return;
  try {
    const resp = await dlrApi(`${API_BASE}/dealership/inventory/${id}/alternatives?limit=5`, {});
    if (!resp.ok) { box.innerHTML = '<div class="dlr-muted">—</div>'; return; }
    const data = await resp.json();
    const items = data.items || [];
    if (!items.length) {
      const reason = data.reason === "no_price" ? "No price on this car — can't match."
        : data.reason === "no_body_class" ? "No body style on this car — can't match."
        : "No similar vehicles found.";
      box.innerHTML = `<div class="dlr-muted">${reason}</div>`;
      return;
    }
    box.innerHTML = items.map((it) => {
      const photo = dlrFirstPhoto(it);
      const thumb = photo
        ? `<img class="dlr-thumb" src="${dlrEsc(photo)}" loading="lazy">`
        : `<div class="dlr-thumb dlr-thumb-empty">🚗</div>`;
      const tag = it.condition ? `<span class="dlr-cond">${dlrEsc(it.condition)}</span>` : "";
      return `
        <div class="dlr-card" data-id="${it.id}">
          ${thumb}
          <div class="dlr-card-body">
            <div class="dlr-card-title">${dlrEsc(dlrTitle(it))} ${tag}</div>
            <div class="dlr-card-sub">${dlrEsc(dlrPrice(it.price))}</div>
          </div>
        </div>`;
    }).join("");
    box.querySelectorAll(".dlr-card").forEach((el) => {
      el.addEventListener("click", () => dlrOpenCar(parseInt(el.dataset.id, 10)));
    });
  } catch (e) {
    box.innerHTML = '<div class="dlr-muted">—</div>';
  }
}
