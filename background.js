/**
 * DealersOrbit Background Service Worker
 * ─────────────────────────────────────
 * Handles:
 *   1. GET_CONFIG     — returns scraper config for a domain
 *   2. ADD_TO_QUEUE   — scrapes detail page then adds to queue
 *   3. Queue processing — sends jobs to DealersOrbit backend one at a time
 */

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// SESSION-LOCAL STORAGE (intentionally not synced to backend):
// - pending_review_queue: vehicles being classified this session
// - queue: video generation jobs in progress
// - fb_listing/fb_post/fb_groups_post: transient Facebook posting data
// - subscription_cache: 1hr cache, refreshed from backend on open
//
// BACKEND-SYNCED (persistent across devices):
// - User settings (voice, language, tagline, etc.) via /auth/me
// - Completed listings via /listings/
// - Sold status via listings.is_sold
// - Saved scripts via /saved-scripts/
// - Subscription status via /auth/me

// ── Inline configs ────────────────────────────────────────────
const PROVIDER_CONFIGS = {
  dealer_inspire: {
    name: "Dealer Inspire",
    photo_hints: {
      exterior_position: "first",
      exterior_count: 12,
      interior_position: "after_exterior",
    },
    inventory_page: {
      url_patterns: ["/inventory", "/new-inventory", "/used-inventory",
        "/certified-inventory", "/pre-owned"],
      card_selector: "li.vehicle-card",
      extractors: {
        vin: { type: "attribute", selector: "li.vehicle-card", attribute: "data-vin" },
        uuid: { type: "attribute", selector: "li.vehicle-card", attribute: "data-uuid" },
        title: { type: "text", selector: "h2, h3, [class*='vehicle-title']" },
        price: { type: "text", selector: ".final-price.internetPrice.font-weight-bo, .final-price.internetPrice" },
        mileage: { type: "text", selector: ".highlight-badge", filter: "miles" },
        link: { type: "href", selector: "a" },
        photos: { type: "images", selector: "img", strip_params: true },
      },
    },
    detail_page: {
      url_patterns: ["/used/", "/new/", "/certified/"],
      extractor_script: `
        (() => {
          const vinEl = document.querySelector('[data-vin]') ||
                        document.querySelector('.vin-value') ||
                        document.querySelector('[class*="vin"]');
          const vinText = vinEl?.getAttribute('data-vin') ||
                          vinEl?.innerText?.match(/[A-HJ-NPR-Z0-9]{17}/i)?.[0];
          const bodyVin = document.body.innerText.match(/\\b([A-HJ-NPR-Z0-9]{17})\\b/)?.[1];
          const vin = vinText || bodyVin || null;

          const titleEl = document.querySelector('h1, .vehicle-title, [class*="vehicle-name"]');
          const titleText = titleEl?.innerText?.trim() || '';

          const photoSources = new Set();

          document.querySelectorAll('.slick-slide:not(.slick-cloned) img').forEach(img => {
            const src = img.src || img.dataset.src || img.dataset.lazySrc || '';
            if (src && src.startsWith('http')) photoSources.add(src.replace(/\\?.*$/, ''));
          });

          document.querySelectorAll(
            '[class*="gallery"] img, [class*="carousel"] img, ' +
            '[class*="slider"] img, [class*="photo-viewer"] img, ' +
            '.media-gallery img, .vehicle-media img'
          ).forEach(img => {
            const src = img.src || img.dataset.src || '';
            if (src && src.startsWith('http')) photoSources.add(src.replace(/\\?.*$/, ''));
          });

          document.querySelectorAll('img[src*="pictures.dealer.com"]').forEach(img => {
            const src = img.src?.replace(/\\?.*$/, '');
            if (src) photoSources.add(src);
          });

          const skipPatterns = ['logo','icon','badge','thumb','placeholder','carfax','autocheck','1x1','spacer'];
          const photos = Array.from(photoSources)
            .filter(src => !skipPatterns.some(p => src.toLowerCase().includes(p)))
            .slice(0, 30);

          const priceEl = document.querySelector(
            '.final-price.internetPrice.font-weight-bo, .final-price.internetPrice, ' +
            '[class*="selling-price"], [class*="our-price"]'
          );
          const price = priceEl?.innerText?.trim() || null;

          const mileageEls = Array.from(
            document.querySelectorAll('.highlight-badge, [class*="mileage"], [class*="miles"]')
          );
          const mileage = mileageEls
            .find(el => /miles|mi\\b/i.test(el.innerText))?.innerText?.trim() || null;

          return { vin, title: titleText, photos, price, mileage };
        })()
      `,
    },
  },
};

const DEALERSHIP_CONFIGS = {
  "jbakia.com": {
    dealership_name: "JBA Kia",
    provider: "dealer_inspire",
    overrides: {},
    photo_hints: {
      exterior_position: "last",
      exterior_count: 14,
      interior_position: "middle",
    },
    sold_indicators: [
      'alias-404',
      'redirectFromMissingVDP=true',
      'this vehicle has been sold',
      'no longer available',
    ],
  },
  "www.jbakia.com": {
    dealership_name: "JBA Kia",
    provider: "dealer_inspire",
    overrides: {},
    photo_hints: {
      exterior_position: "last",
      exterior_count: 14,
      interior_position: "middle",
    },
    sold_indicators: [
      'alias-404',
      'redirectFromMissingVDP=true',
      'this vehicle has been sold',
      'no longer available',
    ],
  },
};

const IS_DEV = !("update_url" in chrome.runtime.getManifest());
const API_BASE = IS_DEV
  ? "http://localhost:8000/api/v1"
  : "https://api.dealersorbit.com/api/v1";

// Dealer-config domain lookups normally hit PROD (configs live on EC2), so even a
// dev/unpacked build serves the real approved configs. In dev we ALSO check
// localhost FIRST, so a config generated/approved against the local backend is
// testable end-to-end before it's deployed to prod. Prod builds are unchanged.
const CONFIG_LOOKUP_BASES = IS_DEV
  ? ["http://localhost:8000/api/v1", "https://api.dealersorbit.com/api/v1"]
  : ["https://api.dealersorbit.com/api/v1"];

async function fetchDealerConfigForDomain(domain) {
  for (const base of CONFIG_LOOKUP_BASES) {
    try {
      const resp = await fetch(`${base}/dealer-configs/domain/${domain}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.found && data.config) return data;
      }
    } catch (e) { /* try next base */ }
  }
  return { found: false, config: null };
}

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// Drop-in fetch wrapper for backend calls. Auto-injects the extension version
// header (so the backend can track version distribution) and the auth token.
// Takes an ENDPOINT (e.g. "/jobs/"), not a full URL — API_BASE is prepended.
// Use this for all NEW backend calls; existing raw fetch() calls are unchanged.
async function apiFetch(endpoint, options = {}) {
  const { token } = await chrome.storage.local.get("token");

  const headers = {
    ...(options.headers || {}),
    "X-Extension-Version": EXTENSION_VERSION,
  };

  if (token && !headers["Authorization"]) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  return fetch(`${API_BASE}${endpoint}`, { ...options, headers });
}

async function handleExpiredToken() {
  await chrome.storage.local.remove(["token", "user"]);
  await chrome.storage.local.set({ session_expired: true });
  console.warn("DealersOrbit: Session expired — user will be prompted to sign in");
}

function getConfigForDomain(domain) {
  console.log("DealersOrbit: Looking up domain:", domain);

  // Try exact match first
  if (DEALERSHIP_CONFIGS[domain]) {
    return buildConfig(DEALERSHIP_CONFIGS[domain]);
  }

  // Try without www.
  const withoutWww = domain.replace(/^www\./, "");
  if (DEALERSHIP_CONFIGS[withoutWww]) {
    return buildConfig(DEALERSHIP_CONFIGS[withoutWww]);
  }

  // Try with www.
  const withWww = "www." + withoutWww;
  if (DEALERSHIP_CONFIGS[withWww]) {
    return buildConfig(DEALERSHIP_CONFIGS[withWww]);
  }

  // Cars.com fallback
  if (domain.includes("cars.com")) {
    return { type: "cars_com", name: "Cars.com" };
  }

  return null;
}

function buildConfig(dealerConfig) {
  const providerConfig = PROVIDER_CONFIGS[dealerConfig.provider];
  if (!providerConfig) return null;
  return {
    dealership_name: dealerConfig.dealership_name,
    provider: dealerConfig.provider,
    photo_hints: {
      ...providerConfig.photo_hints,
      ...(dealerConfig.photo_hints || {}),
    },
    inventory_page: {
      ...providerConfig.inventory_page,
      ...(dealerConfig.overrides?.inventory_page || {}),
      extractors: {
        ...providerConfig.inventory_page.extractors,
        ...(dealerConfig.overrides?.inventory_page?.extractors || {}),
      },
    },
    detail_page: {
      ...providerConfig.detail_page,
      ...(dealerConfig.overrides?.detail_page || {}),
    },
  };
}

// ── Adapt AI-generated backend config to content_script format ──
function adaptBackendConfig(aiConfig, domain) {
  const inv    = aiConfig.inventory   || {};
  const fields = inv.fields           || {};
  const dp     = aiConfig.detail_page || {};

  // Include both AI url_pattern and common inventory path patterns so
  // isInventory check in content_script passes reliably.
  const urlPatterns = [
    inv.url_pattern,
    '/used-inventory', '/new-inventory', '/certified-inventory',
    '/pre-owned', '/inventory', '/used/', '/new/', '/certified/',
  ].filter(Boolean);

  return {
    dealership_name: domain,
    provider: aiConfig.platform || 'ai_generated',
    photo_hints: {
      exterior_position: 'first',
      exterior_count: aiConfig.photo_hints?.exterior_count || null,
      interior_position: 'after_exterior',
    },
    sold_indicators: aiConfig.sold_indicators || [],
    inventory_page: {
      url_patterns: urlPatterns,
      card_selector: inv.vehicle_cards || 'li.vehicle-card',
      extractors: {
        vin:     { type: 'text',   selector: fields.vin          || null,   attribute: null },
        title:   { type: 'text',   selector: fields.year         || fields.make || fields.model || null },
        make:    { type: 'text',   selector: fields.make         || fields.model || null },
        price:   { type: 'text',   selector: fields.price        || null },
        mileage: { type: 'text',   selector: fields.mileage      || null,   filter: 'miles' },
        link:    { type: 'href',   selector: fields.listing_url  || 'a' },
        photos:  { type: 'images', selector: fields.image        || 'img',  strip_params: true },
      },
    },
    detail_page: {
      url_patterns: [],
      extractors: {
        vin:     { type: 'text',   selector: dp.vin        || null },
        price:   { type: 'text',   selector: dp.sale_price || null },
        mileage: { type: 'text',   selector: dp.mileage    || null },
        photos:  { type: 'images', selector: dp.photos     || 'img', strip_params: true },
      },
    },
  };
}

// ── Onboarding state (background) ────────────────────────────
let onboardingState = {
  cardSelector:    null,
  detailUrl:       null,
  exteriorClicked: null,
  interiorClicked: null,
  selectedPrice:   null,
  configForNewCars: false,
};

// ── Message handler ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Popup asks whether the logged-in user's dealership domain now resolves to an
  // active config (so it can show a one-time "config ready" notification).
  if (message.type === "CHECK_DEALER_CONFIG_READY") {
    (async () => {
      try {
        const { user } = await chrome.storage.local.get('user');
        const url = user?.dealership_url;
        if (!url) { sendResponse({ ready: false }); return; }
        const domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
        const data = await fetchDealerConfigForDomain(domain);
        sendResponse({ ready: !!(data.found && data.config), platform_id: data.platform_id || null, domain });
      } catch (e) {
        sendResponse({ ready: false });
      }
    })();
    return true;
  }

  if (message.type === "GET_CONFIG") {
    (async () => {
      const domain = message.domain;

      // 0. Locally stored pending config from onboarding — bypasses domain restriction
      //    because this is the user's own freshly-generated config
      const { onboarding_pending_config } = await chrome.storage.local.get('onboarding_pending_config');
      if (onboarding_pending_config?.config) {
        const pendingDomain = (onboarding_pending_config.domain || '').replace(/^www\./, '');
        const currentDomainStripped = domain.replace(/^www\./, '');
        if (pendingDomain && currentDomainStripped === pendingDomain) {
          console.log(`DealersOrbit: Using locally stored onboarding config for ${domain}`);
          sendResponse({ config: adaptBackendConfig(onboarding_pending_config.config, domain), source: 'pending' });
          return;
        }
      }

      // Cars.com — bypass domain restriction; show buttons on ALL listings.
      if (domain.includes("cars.com")) {
        sendResponse({
          config: { type: "cars_com", name: "Cars.com", _filter_dealer_name: null },
          source: "hardcoded",
        });
        return;
      }

      // CarGurus — universal import source, no dealer filtering.
      if (domain.includes("cargurus.com")) {
        sendResponse({
          config: { type: "cargurus", name: "CarGurus", _filter_dealer_name: null },
          source: "hardcoded",
        });
        return;
      }

      // Domain restriction — only serve config for user's registered dealership
      const ADMIN_EMAILS = ['yoseph@jbakia.com', 'yosephfl@gmail.com'];
      const { user } = await chrome.storage.local.get('user');
      const isAdmin = ADMIN_EMAILS.includes(user?.email?.toLowerCase());

      if (!isAdmin && user?.dealership_url) {
        const userDomain = user.dealership_url.split('/')[0].replace(/^www\./, '');
        const currentDomain = domain.replace(/^www\./, '');
        if (currentDomain !== userDomain && !currentDomain.endsWith('.' + userDomain)) {
          sendResponse({ config: null, source: 'restricted' });
          return;
        }
      }

      // 1. Check backend for AI-generated active config (prod; dev also checks localhost first)
      try {
        const data = await fetchDealerConfigForDomain(domain);
        console.log(`DealersOrbit: Backend response:`, data.found, data.platform);
        if (data.found && data.config) {
          console.log(`DealersOrbit: Using backend config for ${domain} (platform: ${data.platform})`);
          sendResponse({ config: adaptBackendConfig(data.config, domain), source: "backend" });
          return;
        }
      } catch (err) {
        console.log("DealersOrbit: Backend config lookup failed, falling back:", err.message);
      }

      // 2. Fall back to hardcoded dealership_config.js
      const config = getConfigForDomain(domain);
      if (config) {
        console.log(`DealersOrbit: Using hardcoded config for ${domain}`);
        sendResponse({ config, source: "hardcoded" });
        return;
      }

      // 3. No config found
      console.log(`DealersOrbit: No config for ${domain} — using generic scraper`);
      sendResponse({ config: null, source: "generic" });
    })();
    return true;
  }

  if (message.type === "CAPTURE_CONFIG_HTML") {
    (async () => {
      try {
        const { token } = await chrome.storage.local.get('token');
        if (!token) { sendResponse({ success: false, error: 'Not logged in.' }); return; }

        // lastFocusedWindow gets the browser tab behind the popup
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) { sendResponse({ success: false, error: 'No active tab found. Please open your inventory page in a browser tab first.' }); return; }

        // Capture first vehicle card from the inventory page
        const cardResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const SELECTORS = [
              '[data-vehicle]','[data-vehicle-id]','[data-listing-id]','[data-vin]',
              '.vehicle-card','.inventory-listing-item','.result-wrap','.listing-item',
              '.ddc-item-info-wrapper','[class*="vehicle-card"]','[class*="inventory-item"]',
              '[class*="vehicle-listing"]','[class*="listing-item"]',
              'article[class*="vehicle"]','li[class*="vehicle"]',
            ];
            for (const sel of SELECTORS) {
              try {
                const els = document.querySelectorAll(sel);
                if (els.length < 2) continue;
                const card = els[0];
                const patterns = ['/used/', '/inventory/', '/vehicle', '/vdp/', '/cars/', '/used-', '/new/'];
                let detailUrl = null;
                for (const p of patterns) {
                  const a = card.querySelector(`a[href*="${p}"]`);
                  if (a?.href) { detailUrl = a.href; break; }
                }
                if (!detailUrl) {
                  const a = Array.from(card.querySelectorAll('a[href]'))
                    .find(a => a.href && a.href !== window.location.href && !a.href.includes('#'));
                  if (a) detailUrl = a.href;
                }
                return { card_html: card.outerHTML, detail_url: detailUrl, selector: sel };
              } catch (e) {}
            }
            return null;
          },
        });

        const cardData = cardResults?.[0]?.result;
        if (!cardData) {
          sendResponse({ success: false, error: 'No vehicle cards found. Please navigate to your inventory page first.' });
          return;
        }

        console.log(`DealersOrbit: Captured card HTML (${cardData.card_html.length} chars) with ${cardData.selector}`);

        // Capture detail page HTML fragments
        let detailHtml = null;
        if (cardData.detail_url) {
          let detailTab = null;
          try {
            detailTab = await chrome.tabs.create({ url: cardData.detail_url, active: false });
            await waitForTabLoad(detailTab.id);
            await sleep(3000);

            const detailResults = await chrome.scripting.executeScript({
              target: { tabId: detailTab.id },
              func: () => {
                const safeQ = (sel) => { try { return document.querySelector(sel); } catch (e) { return null; } };
                const priceSels = ['#price-box','.vdp-price-box','.price-box','.pricing-detail','[class*="pricing"]','.vehicle-pricing','dl.pricing-detail','[class*="price-block"]'];
                const specSels  = ['.basic-info-component','.vehicle-details','.specs-table','[class*="spec"]','dl.dl-horizontal','.vehicle-info','.vehicle-specs'];
                const galSels   = ['.vdp-gallery','.media-gallery','[class*="gallery"]','.vehicle-photos','.photo-gallery'];
                const fragments = [];
                for (const sel of priceSels) { const el = safeQ(sel); if (el) { fragments.push(`<!-- PRICE SECTION -->\n${el.outerHTML}`); break; } }
                for (const sel of specSels)  { const el = safeQ(sel); if (el) { fragments.push(`<!-- SPEC SECTION -->\n${el.outerHTML}`);  break; } }
                for (const sel of galSels)   { const el = safeQ(sel); if (el) { fragments.push(`<!-- GALLERY -->\n${el.outerHTML}`);         break; } }
                return fragments.join('\n\n') || null;
              },
            });
            detailHtml = detailResults?.[0]?.result || null;
            console.log(`DealersOrbit: Captured detail HTML (${detailHtml?.length || 0} chars)`);
          } finally {
            if (detailTab) try { await chrome.tabs.remove(detailTab.id); } catch (e) {}
          }
        }

        // Always POST to prod — no auth needed, configs go to pending_review for manual approval
        const resp = await fetch(`https://api.dealersorbit.com/api/v1/dealer-configs/generate-from-html`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card_html: cardData.card_html, detail_html: detailHtml, source_url: tab.url }),
        });

        // 409 = config already exists for this domain — treat as success, let user proceed
        if (resp.status === 409) {
          await chrome.storage.local.set({ dealer_configured: true, config_status: 'pending_review' });
          sendResponse({ success: true, already_existed: true });
          return;
        }

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          sendResponse({ success: false, error: err.detail || 'Config generation failed.' });
          return;
        }

        const result = await resp.json();
        await chrome.storage.local.set({ dealer_configured: true, config_status: 'pending_review' });
        sendResponse({ success: true, platform_id: result.platform_id });

      } catch (err) {
        console.error('DealersOrbit: CAPTURE_CONFIG_HTML failed:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "ADD_TO_QUEUE") {
    (async () => {
      // Trial gate: importing triggers Claude photo classification (costs API
      // credits). Block it for users who are out of trial before any scraping.
      const blockReason = await getTrialBlockReason();
      if (blockReason) {
        console.log("DealersOrbit: Import blocked — out of trial:", blockReason);
        sendResponse({ success: false, trial_blocked: true, error: blockReason });
        return;
      }
      console.log("DealersOrbit: Received vehicle, fetching detail page...", message.vehicle);
      const vehicle = message.vehicle;
      // Pass source tab ID for VDP imports so enrichment can run on the current tab
      if (vehicle.vdp_import && sender?.tab?.id) {
        vehicle._source_tab_id = sender.tab.id;
      }
      try {
        const result = await enrichAndQueue(vehicle);
        // Mark that the user has imported at least one vehicle — dismisses the
        // first-import welcome prompt permanently.
        await chrome.storage.local.set({ has_imported_vehicle: true });
        sendResponse({ success: true, queueLength: result });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "QUEUE_REVIEWED") {
    genQueueAdditions.push({
      vehicle:     message.vehicle,
      videoType:   message.video_type   || "slideshow",
      theme:       message.theme        || "family",
      customScript: message.custom_script || null,
      outroVideoId: message.outro_video_id || null,
      language:    message.language     || 'en',
    });
    drainGenQueueAdditions()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "CLASSIFY_PENDING") {
    classifyInBackground(message.vehicle, message.queue_item_id || null);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "ADD_TO_FB_QUEUE") {
    (async () => {
      const { listing, vehicle } = message;
      await chrome.storage.local.set({
        fb_listing: {
          ...listing,
          vehicle:    vehicle,
          created_at: new Date().toISOString(),
        }
      });
      chrome.tabs.create({ url: "https://www.facebook.com/marketplace/create/vehicle" });
      sendResponse({ success: true });
    })().catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "MARK_LISTING_POSTED") {
    markListingPosted(message.vehicle, message.listing_url)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false }));
    return true;
  }

  // Records the Marketplace posting EVENT (posted_marketplace) via /track-posting —
  // mirrors FB_POST_COMPLETE / FB_GROUPS_POST_COMPLETE for the other two channels.
  // Sold-check registration is handled separately by MARK_LISTING_POSTED, so this
  // fires every time a marketplace form-fill completes, independent of dedup.
  if (message.type === "MARKETPLACE_POST_COMPLETE") {
    (async () => {
      const { token } = await chrome.storage.local.get("token");
      if (token && message.vehicle) {
        fetch(`${API_BASE}/listings/track-posting`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({
            event_type:    "posted_marketplace",
            vin:           message.vehicle.vin,
            vehicle_year:  message.vehicle.year,
            vehicle_make:  message.vehicle.make,
            vehicle_model: message.vehicle.model,
            vehicle_price: message.vehicle.price,
          }),
        }).catch(e => console.log("Analytics tracking failed:", e));
      }
    })();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "FETCH_FILES") {
    (async () => {
      const results = [];
      for (const { url, isVideo } of (message.files || [])) {
        try {
          const resp = await fetch(url);
          if (!resp.ok) {
            results.push({ url, ok: false, error: `HTTP ${resp.status}` });
            continue;
          }
          const buffer = await resp.arrayBuffer();
          const contentType = resp.headers.get("content-type") ||
            (isVideo ? "video/mp4" : "image/jpeg");
          // Chrome extension message passing uses JSON serialization — ArrayBuffers
          // are lost. Convert to base64 string so binary data survives the round-trip.
          const bytes = new Uint8Array(buffer);
          let binary = '';
          const chunk = 8192;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          const base64 = btoa(binary);
          results.push({ url, ok: true, base64, contentType, isVideo });
        } catch (e) {
          results.push({ url, ok: false, error: e.message });
        }
      }
      sendResponse({ results });
    })();
    return true;
  }

  if (message.type === "FB_POST_COMPLETE") {
    chrome.storage.local.remove("fb_post");
    console.log("DealersOrbit: FB Post complete for job", message.job_id);
    (async () => {
      const { token } = await chrome.storage.local.get("token");
      if (token && message.vehicle) {
        fetch(`${API_BASE}/listings/track-posting`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({
            event_type:    "posted_fb_post",
            vin:           message.vehicle.vin,
            vehicle_year:  message.vehicle.year,
            vehicle_make:  message.vehicle.make,
            vehicle_model: message.vehicle.model,
            vehicle_price: message.vehicle.price,
          }),
        }).catch(e => console.log("Analytics tracking failed:", e));
      }
    })();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "RUN_SOLD_CHECK") {
    runDailySoldCheck(true)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ sold_ids: [] }));
    return true;
  }

  if (message.type === 'FB_GROUPS_POST_COMPLETE') {
    console.log('DealersOrbit: FB groups post completed');
    (async () => {
      const { token } = await chrome.storage.local.get("token");
      if (token && message.vehicle) {
        fetch(`${API_BASE}/listings/track-posting`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({
            event_type:    "posted_fb_groups",
            vin:           message.vehicle.vin,
            groups_count:  message.groups_count || 0,
            vehicle_year:  message.vehicle.year,
            vehicle_make:  message.vehicle.make,
            vehicle_model: message.vehicle.model,
            vehicle_price: message.vehicle.price,
          }),
        }).catch(e => console.log("Analytics tracking failed:", e));
      }
    })();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'RESTART_POLLING') {
    (async () => {
      const { queue = [] } = await chrome.storage.local.get('queue');
      const job = queue.find(j => j.id === message.job_id);
      if (job && (job.status === 'generating' || job.status === 'waiting')) {
        console.log('DealersOrbit: Restarting poll for job', job.id);
        processQueue();
      }
      sendResponse({ success: true });
    })().catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'CARD_CLICKED') {
    (async () => {
      onboardingState.cardSelector = message.cardSelector;
      onboardingState.detailUrl    = message.detailUrl;
      console.log('DealersOrbit onboarding: card clicked, selector:', message.cardSelector);
      await chrome.storage.local.set({
        onboarding_card_selector:  message.cardSelector,
        onboarding_detail_url:     message.detailUrl,
        onboarding_waiting_detail: true,
      });
      sendResponse({ success: true });
    })().catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'PHOTO_CLICKED') {
    if (message.photoType === 'exterior') {
      onboardingState.exteriorClicked = { src: message.src, selector: message.selector };
    } else {
      onboardingState.interiorClicked = { src: message.src, selector: message.selector };
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'PHOTOS_DONE') {
    extractPricesFromDetailPage();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'FLAG_FOR_MANUAL_REVIEW') {
    (async () => {
      const { token, onboarding_config_id } =
        await chrome.storage.local.get(['token', 'onboarding_config_id']);
      if (token && onboarding_config_id) {
        fetch(`https://api.dealersorbit.com/api/v1/dealer-configs/${onboarding_config_id}/flag-manual`, {
          method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
        }).catch(() => {});
      }
      sendResponse({ success: true });
    })().catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'RETRY_ENRICHMENT') {
    (async () => {
      // Remove the stale incomplete card so the retry REPLACES it rather than
      // creating a duplicate (enrichSingleVehicle re-adds with a fresh id and
      // only dedups by VIN — which the incomplete card was missing).
      const { pending_review_queue = [] } =
        await chrome.storage.local.get('pending_review_queue');
      const filtered = pending_review_queue.filter(
        i => i.queue_item_id !== message.queue_item_id
      );
      await chrome.storage.local.set({ pending_review_queue: filtered });

      // Re-enrich from listing_url (opens a fresh tab), clearing stale flags.
      const v = { ...message.vehicle };
      delete v.scrape_incomplete;
      delete v.scrape_incomplete_reason;
      await enrichAndQueue(v);
      sendResponse({ success: true });
    })().catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return true;
});

async function extractPricesFromDetailPage() {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const detailTab = tabs.find(t => t.active);
  if (!detailTab) {
    chrome.runtime.sendMessage({ type: 'SHOW_PRICE_SELECTION', prices: [] });
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: detailTab.id },
      func:   extractAllPrices,
    });
    const prices = results?.[0]?.result || [];
    console.log('DealersOrbit onboarding: extracted prices:', prices);
    await chrome.storage.local.set({ onboarding_prices: prices });
    chrome.runtime.sendMessage({ type: 'SHOW_PRICE_SELECTION', prices });
  } catch (err) {
    console.error('DealersOrbit: price extraction failed:', err);
    chrome.runtime.sendMessage({ type: 'SHOW_PRICE_SELECTION', prices: [] });
  }
}

function extractAllPrices() {
  const prices = [];
  const seen   = new Set();

  // Strategy 1: dl dt/dd price table (Dealer.com / DDC)
  document.querySelectorAll('dl dt, dl.pricing-detail dt').forEach(dt => {
    const dd = dt.nextElementSibling;
    if (!dd) return;
    const label   = dt.textContent.trim().replace(/\s+/g, ' ');
    const valueEl = dd.querySelector('.price-value') || dd;
    const match   = valueEl.textContent.match(/\$[\d,]+/);
    if (!match) return;
    const value = match[0];
    if (seen.has(value)) return;
    const skipLabels = ['msrp', 'retail value', 'savings', 'discount', 'rebate', 'incentive'];
    if (skipLabels.some(s => label.toLowerCase().includes(s))) return;
    seen.add(value);
    prices.push({ label, value, selector: null, raw: valueEl.textContent.trim() });
  });

  // Strategy 2: elements with price-related classes
  document.querySelectorAll(
    '[class*="price"]:not([class*="msrp"]):not([class*="retail"]),' +
    '[class*="Price"]:not([class*="Msrp"]):not([class*="Retail"])'
  ).forEach(el => {
    const match = el.textContent.match(/\$[\d,]+/);
    if (!match) return;
    const value = match[0];
    if (seen.has(value)) return;
    if (parseInt(value.replace(/[$,]/g, '')) < 1000) return;
    const parent   = el.closest('li, tr, div[class*="price"], div[class*="Price"]');
    const labelEl  = parent?.querySelector('span, label, dt, th') || el.previousElementSibling;
    const label    = labelEl?.textContent?.trim().replace(/\s+/g, ' ') ||
                     el.className.replace(/[^a-zA-Z\s]/g, ' ').trim();
    if (label.length > 50) return;
    seen.add(value);
    prices.push({ label: label || 'Price', value, selector: null, raw: el.textContent.trim() });
  });

  // Sort ascending (MSRP highest, advertised price lower)
  prices.sort((a, b) =>
    parseInt(a.value.replace(/[$,]/g, '')) - parseInt(b.value.replace(/[$,]/g, ''))
  );

  return prices.slice(0, 8);
}

/**
 * Use photo_hints to select the most likely exterior/interior photos
 * from the full scraped photo array before sending to classifier.
 * This avoids classifying 37 photos when we know where the good ones are.
 */
function applyPhotoHints(photos, photoHints) {
  if (!photoHints || !photos.length) return photos.slice(0, 20);

  const total = photos.length;
  const extCount = photoHints.exterior_count || 12;
  const extPos = photoHints.exterior_position || "first";

  let exteriorCandidates = [];
  let interiorCandidates = [];

  if (extPos === "first") {
    exteriorCandidates = photos.slice(0, extCount);
    interiorCandidates = photos.slice(extCount, extCount + 8);
  } else if (extPos === "last") {
    exteriorCandidates = photos.slice(Math.max(0, total - extCount));
    interiorCandidates = photos.slice(1, Math.max(1, total - extCount));
  } else {
    return photos.slice(0, 20);
  }

  const combined = [...new Set([...exteriorCandidates, ...interiorCandidates])];
  return combined.slice(0, 20);
}

// ── Global processing locks ────────────────────────────────
let isEnriching = false;
const enrichQueue = [];

// Track which job IDs already have an active resumePolling loop
const resumingJobIds = new Set();

// Mutex for the generation queue. processQueue() is entered from several
// places (addToQueue, RESTART_POLLING, the post-job recursion, resumePolling
// completion); without this, two entries could both pick the same `waiting`
// job before either persists `generating` and submit it TWICE (two backend
// jobs → two pipelines → duplicate Shotstack renders). Set synchronously
// before any await, so it's airtight in single-threaded JS.
let isProcessingQueue = false;

let isClassifying = false;
const classifyQueue = [];

let isAddingToGenQueue = false;
const genQueueAdditions = [];

// Returns a trial-block reason if the user is out of trial, else null.
// Reads the popup-maintained subscription_cache (session-local storage).
//   'TRIAL_EXPIRED'     — trial window ended (or subscription inactive)
//   'TRIAL_VIDEO_LIMIT' — trial user who has used all 5 free videos
async function getTrialBlockReason() {
  const { subscription_cache: c } = await chrome.storage.local.get('subscription_cache');
  if (!c) return null;  // no cache yet — fail open; popup populates it on open
  if (c.is_blocked) {
    return c.subscription_message === 'trial_expired' ? 'TRIAL_EXPIRED' : 'TRIAL_VIDEO_LIMIT';
  }
  if (c.subscription_status === 'trial' && (c.trial_video_count || 0) >= 5) {
    return 'TRIAL_VIDEO_LIMIT';
  }
  return null;
}

async function enrichAndQueue(vehicle) {
  enrichQueue.push(vehicle);

  if (isEnriching) {
    console.log(`DealersOrbit: Queued for enrichment: ${vehicle.model}`);
    return;
  }

  isEnriching = true;
  try {
    while (enrichQueue.length > 0) {
      const next = enrichQueue.shift();
      await enrichSingleVehicle(next);
    }
  } catch (err) {
    console.error("DealersOrbit: Enrich queue error:", err);
  } finally {
    isEnriching = false;  // ← always reset even on error
  }
}

function isNewCarUrl(url) {
  if (!url) return false;
  const path = new URL(url).pathname.toLowerCase();
  return /\/new[-/]|\/exotic-new\/|\/new-inventory\/|\/new-vehicles\/|\/new-cars\//.test(path);
}

// A scrape is "complete" when we have the fields an ad actually needs.
// Used to decide whether a Cars.com scrape should be retried (e.g. after a
// Cloudflare challenge returned a half-rendered page).
function isDataComplete(detailData) {
  return !!(
    detailData?.vin &&
    detailData?.price &&
    Array.isArray(detailData?.photos) &&
    detailData.photos.length > 0
  );
}

// Run an injected extractor and retry once if the result is incomplete
// (Cloudflare interstitial, LiveView still rendering, etc). Returns the
// best-effort data even if still incomplete after all attempts.
async function extractWithRetry(extractFn, tabId, maxAttempts = 2) {
  let detailData = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func:   extractFn,
      args:   [],
    });
    detailData = results?.[0]?.result;

    if (isDataComplete(detailData)) {
      if (attempt > 1) {
        console.log(`DealersOrbit: Scrape succeeded on retry attempt ${attempt}`);
      }
      return detailData;
    }

    if (attempt < maxAttempts) {
      console.log(`DealersOrbit: Incomplete scrape (attempt ${attempt}), retrying in 2s...`);
      await sleep(2000);
    }
  }

  console.log('DealersOrbit: Scrape still incomplete after retries');
  return detailData;
}

// Apply the config's photo URL filter to vehicle.photos. Runs BEFORE
// applyPhotoHints + classification so the 20-photo selection and the classifier
// only ever see this car's photos (not "similar vehicles" / banners). Forgiving
// if the admin typed a sentence — extracts the URL-ish token. No-op if unset.
function applyConfigPhotoFilter(vehicle, photosUrlInclude, label) {
  if (!photosUrlInclude) {
    console.log(`DealersOrbit [photo-filter] (${label}) no photos_url_include | photos=${(vehicle.photos||[]).length}`);
    return;
  }
  const m = String(photosUrlInclude).match(/[\w-]+(?:\.[\w-]+)+(?:\/[\w./-]*)?/);
  const inc = (m ? m[0] : String(photosUrlInclude)).toLowerCase();
  const before = (vehicle.photos || []).length;
  const filtered = (vehicle.photos || []).filter(u => String(u).toLowerCase().includes(inc));
  if (filtered.length) vehicle.photos = filtered;
  console.log(`DealersOrbit [photo-filter] (${label}) "${inc}": photos ${before}->${(vehicle.photos||[]).length}`);
}

async function enrichSingleVehicle(vehicle) {
  console.log("DealersOrbit: enrichSingleVehicle:", vehicle.model);
  console.log("DealersOrbit: listing_url:", vehicle.listing_url);

  // Config-driven photo URL filter (set via the Config Generator's photo filter).
  // Captured at function scope so the common exit can apply it to whatever the
  // extraction paths produced — the authoritative filter for "photos from other cars".
  let photosUrlInclude = null;

  // VDP imports: user is already on the detail page — run extractDetailPageData
  // on the source tab instead of opening a new one
  if (vehicle.vdp_import) {
    console.log("DealersOrbit: VDP import — extracting from source tab");

    let detailPageSelectors = {};
    let photoHintsFromConfig = null;

    if (vehicle.listing_url) {
      try {
        const domain = new URL(vehicle.listing_url).hostname;
        const cfgData = await fetchDealerConfigForDomain(domain);
        {
          if (cfgData.found && cfgData.config) {
            if (cfgData.config.detail_page) detailPageSelectors = cfgData.config.detail_page;
            if (cfgData.config.detail_page?.photos_url_include) {
              photosUrlInclude = cfgData.config.detail_page.photos_url_include;
            }
            console.log(`DealersOrbit [cfg] VDP config found=${cfgData.found} photos_url_include=${cfgData.config.detail_page?.photos_url_include || '(none)'}`);
            if (cfgData.config.photo_hints?.exterior_count) {
              photoHintsFromConfig = {
                exterior_position: 'first',
                exterior_count: cfgData.config.photo_hints.exterior_count,
                interior_position: 'after_exterior',
              };
            }
          }
        }
        // Always check hardcoded for photo hints — backend photo_hints are often null
        const hardcoded = getConfigForDomain(domain);
        if (!Object.keys(detailPageSelectors).length && hardcoded?.detail_page) {
          detailPageSelectors = hardcoded.detail_page;
        }
        if (!photoHintsFromConfig && hardcoded?.photo_hints) {
          photoHintsFromConfig = hardcoded.photo_hints;
        }
      } catch (err) {}
    }

    if (vehicle._source_tab_id) {
      try {
        await sleep(2000); // give page time for lazy images to load
        const isCarsComVdp  = vehicle.listing_url?.includes('cars.com/vehicledetail/');
        const isCarGurusVdp = vehicle.listing_url?.includes('cargurus.com/details/');
        const results = await chrome.scripting.executeScript({
          target: { tabId: vehicle._source_tab_id },
          func:   isCarsComVdp  ? extractCarsDotComVdpData  :
                  isCarGurusVdp ? extractCarGurusVdpData    :
                  extractDetailPageData,
          args:   (isCarsComVdp || isCarGurusVdp) ? [] : [detailPageSelectors],
        });
        const detailData = results?.[0]?.result;
        console.log(`DealersOrbit: VDP detail data:`, detailData);
        if (detailData && !detailData._error) {
          vehicle.vin            = detailData.vin            || vehicle.vin;
          vehicle.price          = detailData.price          || vehicle.price;
          vehicle.mileage        = detailData.mileage        || vehicle.mileage;
          vehicle.exterior_color = detailData.exterior_color || null;
          vehicle.interior_color = detailData.interior_color || null;
          vehicle.body_style     = detailData.body_style     || null;
          if (isCarsComVdp) {
            // Cars.com: always use the filtered photo set — generic scan includes junk
            if (detailData.photos?.length > 0) {
              vehicle.photos = detailData.photos;
              console.log(`DealersOrbit: VDP got ${detailData.photos.length} Cars.com photos`);
            }
            // Fix year/make/model/trim from the accurate page title
            if (detailData.title) {
              vehicle.title = detailData.title;
              const parsed = parseYearMakeModelFromTitle(detailData.title);
              if (parsed.year)  vehicle.year  = parsed.year;
              if (parsed.make)  vehicle.make  = parsed.make;
              if (parsed.model) vehicle.model = parsed.model;
              vehicle.trim = parseTrimFromTitle(
                detailData.title, parsed.year, parsed.make, parsed.model
              ) || null;
              // New cars on Cars.com have very low odometer — label as "New"
              if (/^\s*new\b/i.test(detailData.title) && !detailData.mileage) {
                vehicle.mileage = 'New';
              }
            }
          } else if ((detailData.photos?.length || 0) > (vehicle.photos?.length || 0)) {
            vehicle.photos = detailData.photos;
            console.log(`DealersOrbit: VDP got ${detailData.photos.length} photos from tab`);
          }
        }
      } catch (err) {
        console.log("DealersOrbit: VDP tab extraction failed:", err.message);
      }
    }

    // VIN fallback from URL
    if (!vehicle.vin && vehicle.listing_url) {
      const vinInUrl = vehicle.listing_url.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
      if (vinInUrl) vehicle.vin = vinInUrl[1].toUpperCase();
    }

    // New car mileage — null is correct (not "0 miles"), label as "New"
    if (!vehicle.mileage && isNewCarUrl(vehicle.listing_url)) {
      vehicle.mileage = 'New';
    }

    applyConfigPhotoFilter(vehicle, photosUrlInclude, 'vdp');  // filter BEFORE selecting
    vehicle.photos_for_video = applyPhotoHints(vehicle.photos || [], photoHintsFromConfig);
    console.log(`DealersOrbit: VDP selected ${vehicle.photos_for_video.length} photos`);

  } else {

  // ── Resolve config for this domain (one fetch, used for both selectors + photo hints) ──
  let detailPageSelectors = {};
  let photoHintsFromConfig = null;
  if (vehicle.listing_url) {
    try {
      const domain = new URL(vehicle.listing_url).hostname;

      // Backend config first (prod; dev also checks localhost first)
      const cfgData = await fetchDealerConfigForDomain(domain);
      {
        if (cfgData.found && cfgData.config) {
          if (cfgData.config.detail_page) {
            detailPageSelectors = cfgData.config.detail_page;
            console.log(`DealersOrbit: Using backend detail selectors for ${domain}`);
          }
          if (cfgData.config.detail_page?.photos_url_include) {
            photosUrlInclude = cfgData.config.detail_page.photos_url_include;
          }
          console.log(`DealersOrbit [cfg] config found=${cfgData.found} photos_url_include=${cfgData.config.detail_page?.photos_url_include || '(none)'}`);
          if (cfgData.config.photo_hints?.exterior_count) {
            photoHintsFromConfig = {
              exterior_position: 'first',
              exterior_count: cfgData.config.photo_hints.exterior_count,
              interior_position: 'after_exterior',
            };
          }
        }
      }

      // Always check hardcoded for photo hints — backend photo_hints are often null
      const hardcoded = getConfigForDomain(domain);
      if (!Object.keys(detailPageSelectors).length && hardcoded?.detail_page) {
        detailPageSelectors = hardcoded.detail_page;
        console.log(`DealersOrbit: Using hardcoded detail selectors for ${domain}`);
      }
      if (!photoHintsFromConfig && hardcoded?.photo_hints) {
        photoHintsFromConfig = hardcoded.photo_hints;
      }
    } catch (err) {
      console.log('DealersOrbit: Could not resolve config:', err.message);
    }
  }

  // ── Step 1: Scrape detail page ───────────────────────────
  if (vehicle.listing_url) {
    // Cars.com VDPs: open a background tab but use an async polling extractor
    // that waits for LiveView to finish rendering before scraping.
    // chrome.scripting.executeScript waits for returned Promises, so the
    // injected function can poll up to 15s for the thumbnail grid to appear.
    if (vehicle.listing_url.includes('cars.com/vehicledetail/')) {
      let carsTab = null;
      try {
        carsTab = await chrome.tabs.create({ url: vehicle.listing_url, active: false });
        await waitForTabLoad(carsTab.id);
        const carsData = await extractWithRetry(extractCarsDotComVdpDataWithWait, carsTab.id);
        console.log(`DealersOrbit: Cars.com VDP data:`, carsData?.photos?.length, 'photos, title:', carsData?.title);
        if (!isDataComplete(carsData)) {
          vehicle.scrape_incomplete = true;
          vehicle.scrape_incomplete_reason =
            !carsData?.vin   ? 'Missing VIN' :
            !carsData?.price ? 'Missing price' :
            'Missing photos';
          console.warn(`DealersOrbit: Cars.com scrape INCOMPLETE — ${vehicle.scrape_incomplete_reason} (vin=${!!carsData?.vin}, price=${!!carsData?.price}, photos=${carsData?.photos?.length || 0}). Retry available on the card.`);
        } else {
          console.log('DealersOrbit: Cars.com scrape complete ✓ (vin + price + photos present)');
        }
        if (carsData && !carsData._error) {
          vehicle.vin     = carsData.vin     || vehicle.vin;
          vehicle.price   = carsData.price   || vehicle.price;
          vehicle.mileage = carsData.mileage || vehicle.mileage;
          vehicle.exterior_color = carsData.exterior_color || vehicle.exterior_color || null;
          vehicle.interior_color = carsData.interior_color || null;
          if (carsData.title) {
            vehicle.title = carsData.title;
            const parsed = parseYearMakeModelFromTitle(carsData.title);
            if (parsed.year)  vehicle.year  = parsed.year;
            if (parsed.make)  vehicle.make  = parsed.make;
            if (parsed.model) vehicle.model = parsed.model;
            vehicle.trim = parseTrimFromTitle(carsData.title, parsed.year, parsed.make, parsed.model) || vehicle.trim || null;
            if (/^\s*new\b/i.test(carsData.title) && !carsData.mileage) vehicle.mileage = 'New';
          }
          if (carsData.photos?.length > (vehicle.photos?.length || 0)) {
            vehicle.photos = carsData.photos;
          }
        }
      } catch (err) {
        console.log('DealersOrbit: Cars.com VDP tab failed:', err.message);
      } finally {
        if (carsTab) try { await chrome.tabs.remove(carsTab.id); } catch (_) {}
      }
      vehicle.photos_for_video = applyPhotoHints(vehicle.photos || [], null);
      console.log(`DealersOrbit: Selected ${vehicle.photos_for_video.length} photos`);
    } else if (vehicle.listing_url.includes('cargurus.com/details/')) {
      // CarGurus VDP: open background tab with async polling extractor
      let cgTab = null;
      try {
        cgTab = await chrome.tabs.create({ url: vehicle.listing_url, active: false });
        await waitForTabLoad(cgTab.id);
        const cgResults = await chrome.scripting.executeScript({
          target: { tabId: cgTab.id },
          func:   extractCarGurusVdpDataWithWait,
          args:   [],
        });
        const cgData = cgResults?.[0]?.result;
        console.log(`DealersOrbit: CarGurus VDP data:`, cgData?.photos?.length, 'photos, title:', cgData?.title);
        if (cgData && !cgData._error) {
          vehicle.vin     = cgData.vin     || vehicle.vin;
          vehicle.price   = cgData.price   || vehicle.price;
          vehicle.mileage = cgData.mileage || vehicle.mileage;
          vehicle.exterior_color = cgData.exterior_color || vehicle.exterior_color || null;
          vehicle.interior_color = cgData.interior_color || null;
          vehicle.body_style     = cgData.body_style     || vehicle.body_style || null;
          if (cgData.trim && (!vehicle.trim || isGenericCardText(vehicle.trim))) vehicle.trim = cgData.trim;
          if (cgData.title) {
            vehicle.title = cgData.title;
            const parsed = parseYearMakeModelFromTitle(cgData.title);
            if (parsed.year)  vehicle.year  = parsed.year;
            if (parsed.make)  vehicle.make  = parsed.make;
            if (parsed.model) vehicle.model = parsed.model;
          }
          if (cgData.photos?.length > (vehicle.photos?.length || 0)) {
            vehicle.photos = filterJunkPhotos(cgData.photos);
          }
        }
      } catch (err) {
        console.log('DealersOrbit: CarGurus VDP tab failed:', err.message);
      } finally {
        if (cgTab) try { await chrome.tabs.remove(cgTab.id); } catch (_) {}
      }
      vehicle.photos_for_video = applyPhotoHints(vehicle.photos || [], null);
      console.log(`DealersOrbit: Selected ${vehicle.photos_for_video.length} photos`);

    } else {

    let tab = null;
    try {
      console.log(`DealersOrbit: Opening detail page: ${vehicle.listing_url}`);
      tab = await chrome.tabs.create({
        url: vehicle.listing_url,
        active: false,
      });

      await waitForTabLoad(tab.id);
      await sleep(4000);

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func:   extractDetailPageData,
        args:   [detailPageSelectors],
      });

      const scriptResult = results?.[0];
      if (scriptResult?.error) {
        console.warn(`DealersOrbit: executeScript error for ${vehicle.model}:`, scriptResult.error);
      }
      const detailData = scriptResult?.result;
      console.log(`DealersOrbit: Detail page data for ${vehicle.model}:`, detailData);

      if (detailData) {
        // VIN is a definitive match — trust detail data if VINs agree
        const vinFromUrl = vehicle.listing_url?.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i)?.[1]?.toUpperCase();
        const vinMatch = detailData.vin && (
          detailData.vin.toUpperCase() === (vehicle.vin || '').toUpperCase() ||
          detailData.vin.toUpperCase() === (vinFromUrl || '')
        );

        const titleMatch = vinMatch || !detailData.title ||
          detailData.title.toLowerCase().includes((vehicle.model || '').toLowerCase().split(' ')[0]) ||
          detailData.title.toLowerCase().includes((vehicle.make || '').toLowerCase()) ||
          (vehicle.year && detailData.title.includes(vehicle.year));

        if (!titleMatch) {
          console.warn(`DealersOrbit: Title mismatch! Expected ${vehicle.model}, got ${detailData.title}. Skipping detail data.`);
        } else {
          vehicle.vin     = detailData.vin     || vehicle.vin;
          vehicle.price   = detailData.price   || vehicle.price;
          vehicle.mileage = detailData.mileage || vehicle.mileage;
          // Save raw title for display — popup strips "New"/"Used" prefix
          if (detailData.title && !vehicle.title) vehicle.title = detailData.title;

          if (detailData.photos?.length > (vehicle.photos?.length || 0)) {
            vehicle.photos = filterJunkPhotos(detailData.photos);
            console.log(`DealersOrbit: Got ${vehicle.photos.length} full photos`);
          }

          // When VIN matched but card gave garbage year/make/model, parse from detail title
          if (vinMatch && detailData.title) {
            const parsed = parseYearMakeModelFromTitle(detailData.title);
            if (!vehicle.year  || !vehicle.year.match(/^\d{4}$/))  vehicle.year  = parsed.year;
            if (!vehicle.make  || vehicle.make.length < 2)          vehicle.make  = parsed.make;
            if (!vehicle.model || isGenericCardText(vehicle.model)) vehicle.model = parsed.model;
          }

          if ((!vehicle.trim || isGenericCardText(vehicle.trim)) && detailData.title) {
            vehicle.trim = parseTrimFromTitle(
              detailData.title, vehicle.year, vehicle.make, vehicle.model
            );
          }

          vehicle.exterior_color = detailData.exterior_color || null;
          vehicle.interior_color = detailData.interior_color || null;
          vehicle.body_style = detailData.body_style || vehicle.body_style || null;
          console.log(`DealersOrbit: Colors — exterior: ${vehicle.exterior_color}, interior: ${vehicle.interior_color}`);
          console.log(`DealersOrbit: Body style — ${vehicle.body_style}`);
        }
      }

      // VIN fallback — extract from listing URL if still missing (many sites embed VIN in URL)
      if (!vehicle.vin && vehicle.listing_url) {
        const vinInUrl = vehicle.listing_url.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
        if (vinInUrl) {
          vehicle.vin = vinInUrl[1].toUpperCase();
          console.log(`DealersOrbit: VIN extracted from URL: ${vehicle.vin}`);
        }
      }

      // New car mileage — null is correct (not "0 miles"), label as "New"
      if (!vehicle.mileage && isNewCarUrl(vehicle.listing_url)) {
        vehicle.mileage = 'New';
      }

      // Fallback extraction — runs when config selectors returned nulls
      if (tab && (!vehicle.price || !vehicle.mileage || !vehicle.exterior_color)) {
        try {
          const { onboarding_pending_config } = await chrome.storage.local.get('onboarding_pending_config');
          const priceLabel = onboarding_pending_config?.price_label || null;
          const fallbackResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func:   extractDetailPageFallback,
            args:   [priceLabel],
          });
          const fb = fallbackResults?.[0]?.result || {};
          if (!vehicle.price           && fb.price)          vehicle.price          = fb.price;
          if (!vehicle.mileage         && fb.mileage)        vehicle.mileage        = fb.mileage;
          if (!vehicle.exterior_color  && fb.exterior_color) vehicle.exterior_color = fb.exterior_color;
          if (!vehicle.interior_color  && fb.interior_color) vehicle.interior_color = fb.interior_color;
          if (!vehicle.body_style      && fb.body_style)     vehicle.body_style     = fb.body_style;
          if (fb.price) console.log('DealersOrbit: Fallback price:', fb.price);
        } catch (_) {}
      }

      // Filter junk from card photos too (logos/widgets that slipped past content script)
      vehicle.photos = filterJunkPhotos(vehicle.photos || []);

      // Config photo URL filter BEFORE selecting — so hints pick from clean photos
      applyConfigPhotoFilter(vehicle, photosUrlInclude, 'regular');

      // Apply photo hints — already resolved above, no second fetch needed
      vehicle.photos_for_video = applyPhotoHints(vehicle.photos, photoHintsFromConfig);
      console.log(`DealersOrbit: Selected ${vehicle.photos_for_video.length} photos using hints`);

    } catch (err) {
      console.error("DealersOrbit: Detail page scrape failed:", err);
    } finally {
      if (tab) {
        try { await chrome.tabs.remove(tab.id); } catch (e) { }
      }
    }
    } // end else (generic tab path)
  }

  } // end else (non-VDP)

  // Guard: mileage must contain a digit (or be "New"). A fragile/positional
  // config selector can grab non-numeric text like "Cruise Control" on the live
  // page; drop it rather than show garbage (better blank than wrong).
  if (vehicle.mileage && !/\d/.test(String(vehicle.mileage)) && !/^new$/i.test(String(vehicle.mileage).trim())) {
    console.log('DealersOrbit: dropping non-numeric mileage:', vehicle.mileage);
    vehicle.mileage = null;
  }

  // NOTE: the config photo URL filter now runs earlier — inside each branch via
  // applyConfigPhotoFilter(), BEFORE applyPhotoHints + classification — so the
  // 20-photo selection and the classifier only ever see this car's photos.

  // ── Step 2: Always add to review queue as a card ──────────
  const { pending_review_queue = [] } =
    await chrome.storage.local.get("pending_review_queue");

  const reviewItem = {
    queue_item_id: Date.now().toString(),
    vehicle: vehicle,
    photos_all: vehicle.photos || [],
    photos_for_video: vehicle.photos_for_video || (vehicle.photos || []).slice(0, 20),
    classified: null,
    added_at: new Date().toISOString(),
  };

  // Check for duplicate VIN
  const isDuplicate = pending_review_queue.some(
    item => item.vehicle.vin && item.vehicle.vin === vehicle.vin
  );

  if (isDuplicate) {
    console.log(`DealersOrbit: Skipping duplicate VIN: ${vehicle.vin}`);
    return;
  }

  pending_review_queue.push(reviewItem);
  await chrome.storage.local.set({
    pending_review_queue,
    pending_review: null,
  });

  const total = pending_review_queue.length;
  chrome.action.setBadgeText({ text: String(total) });
  chrome.action.setBadgeBackgroundColor({ color: "#1a56db" });
  console.log(`DealersOrbit: Added ${vehicle.model} to queue. Total: ${total}`);

  // ── Queue for sequential classification ──────────────
  console.log(`DealersOrbit: Queuing classification for ${vehicle.model}...`);
  classifyInBackground(vehicle, reviewItem.queue_item_id);

  // Open side panel
  chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id })
    .catch(() => { });
}

// Push to the sequential classify queue and trigger processing.
// Never called directly with the actual API logic — that's in classifySingleVehicle.
function classifyInBackground(vehicle, queueItemId) {
  classifyQueue.push({ vehicle, queueItemId });
  processClassifyQueue();
}

// Drain the classify queue one vehicle at a time.
async function processClassifyQueue() {
  if (isClassifying) return;
  isClassifying = true;

  try {
    while (classifyQueue.length > 0) {
      const { vehicle, queueItemId } = classifyQueue.shift();
      try {
        await classifySingleVehicle(vehicle, queueItemId);
      } catch (err) {
        console.error("DealersOrbit: Classification failed for", vehicle.model, err);
      }
    }
  } finally {
    // Always release the lock — otherwise one unexpected error jams every
    // subsequent classification (the early `if (isClassifying) return`).
    isClassifying = false;
  }
}

async function classifySingleVehicle(vehicle, queueItemId) {
  const hintPhotos = vehicle.photos_for_video || [];
  const allPhotos  = vehicle.photos || [];

  // Build a 30-photo set that covers both exterior-first and exterior-last orderings:
  // hintPhotos first (already sorted by photo hints for JBA/Dealer Inspire),
  // then first 15 + last 15 of allPhotos to guarantee coverage of both ends.
  const photosToClassify = [...new Set([
    ...hintPhotos,
    ...allPhotos.slice(0, 15),
    ...allPhotos.slice(-15),
  ])].slice(0, 30);

  if (!photosToClassify.length) return;

  const { token } = await chrome.storage.local.get("token");
  if (!token) return;

  // Guard the classify request with a timeout — a stalled fetch would otherwise
  // hang processClassifyQueue forever and silently jam every later classification.
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 45000);
  try {
    const resp = await fetch(`${API_BASE}/photos/classify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ photo_urls: photosToClassify }),
      signal: controller.signal,
    });

    if (resp.status === 401) { await handleExpiredToken(); return; }
    if (!resp.ok) return;

    const classified = await resp.json();

    // Fall back to the first scraped photo ONLY if the classifier found NO
    // exterior at all (so the ad isn't empty). Otherwise TRUST the classification
    // + walkaround order — the backend already returns exterior front-first.
    // Do NOT force the first photo to be the hero: some dealers (e.g. AG Auto)
    // lead with a screen / sunroof / detail shot, and forcing that to the front
    // of exterior made the wrong photo the hero on every car.
    const firstPhoto = allPhotos[0];
    if (firstPhoto && !(classified.exterior || []).length) {
      classified.other      = (classified.other      || []).filter(u => u !== firstPhoto);
      classified.interior   = (classified.interior   || []).filter(u => u !== firstPhoto);
      classified.additional = (classified.additional || []).filter(u => u !== firstPhoto);
      classified.exterior   = [firstPhoto];
      console.log('DealersOrbit: no exterior classified — using first photo as exterior fallback');
    }

    // Lead exterior with the dealer's OWN hero convention: match the first scraped
    // exterior 3/4 (front-left vs front-right — AG uses front-left). If the dealer's
    // lead angle isn't found, the backend's front-left→front-right→front cascade stands.
    try {
      const labelOf = {};
      (classified.classified || []).forEach(p => { labelOf[p.url] = p.label; });
      let dealerHero = null;
      for (const u of allPhotos) {
        const l = labelOf[u];
        if (l === 'exterior_front_left' || l === 'exterior_front_right') { dealerHero = u; break; }
      }
      if (dealerHero && (classified.exterior || []).includes(dealerHero) && classified.exterior[0] !== dealerHero) {
        classified.exterior = [dealerHero, ...classified.exterior.filter(u => u !== dealerHero)];
        console.log(`DealersOrbit: hero set to dealer's lead angle ${labelOf[dealerHero]}`);
      }
    } catch (e) { /* non-fatal — keep backend order */ }

    const explicitOther = Array.from(new Set(classified.other || []));

    // Match by queue_item_id (exact), then VIN, then model+year+price
    const { pending_review_queue = [] } =
      await chrome.storage.local.get("pending_review_queue");

    const idx = pending_review_queue.findIndex(item => {
      if (queueItemId) return item.queue_item_id === queueItemId;
      if (vehicle.vin && item.vehicle?.vin) return item.vehicle.vin === vehicle.vin;
      return item.vehicle?.model === vehicle.model &&
             item.vehicle?.year  === vehicle.year  &&
             item.vehicle?.price === vehicle.price;
    });

    if (idx >= 0) {
      pending_review_queue[idx].classified    = classified;
      pending_review_queue[idx].explicit_other = explicitOther;
      await chrome.storage.local.set({ pending_review_queue });
      console.log(`DealersOrbit: Classification saved — ${vehicle.model} (id: ${queueItemId})`);
    } else {
      console.warn(`DealersOrbit: No queue item found for ${vehicle.model} (id: ${queueItemId})`);
    }

  } catch (err) {
    console.error("DealersOrbit: classifySingleVehicle failed:", err);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Injected into a CarGurus VDP tab when the user is already on the page (rendered).
 * Async so chrome.scripting.executeScript awaits the returned Promise.
 * Must be self-contained (no closure references).
 */
async function extractCarGurusVdpData() {
  const getSpec = (attr) =>
    document.querySelector(`[data-cg-ft="${attr}"] span:last-child`)?.textContent?.trim() || null;

  const title = document.querySelector('h1[data-cg-ft="vdp-listing-title"]')?.innerText?.trim() ||
                document.title || '';
  const vin            = getSpec('vin');
  const mileage        = getSpec('mileage');
  const exterior_color = getSpec('exteriorColor');
  const interior_color = getSpec('interiorColor');
  const body_style     = getSpec('bodyType');
  const trim           = getSpec('trim');

  let price = null;
  const priceEl = document.querySelector('[class*="priceContainer"] h2, [class*="price_1cy3t"] h2');
  if (priceEl) { const m = priceEl.textContent?.match(/\$[\d,]+/); if (m) price = m[0]; }

  // Photo collection — defined inline since injected functions must be self-contained
  const seen = new Set();
  const photos = [];
  const mainImg = document.querySelector('img[alt="Vehicle Full Photo"]');
  const mainSrc = mainImg?.src?.split('?')[0];
  if (mainSrc?.includes('cargurus.com')) { seen.add(mainSrc); photos.push(mainSrc); }
  // Script strategy
  document.querySelectorAll('script').forEach(s => {
    const matches = (s.textContent || '').match(
      /https:\/\/static\.cargurus\.com\/images\/forsale\/[^"'\\]+\.jpeg/g
    ) || [];
    matches.forEach(u => {
      const hr = u.replace(/\d+x\d+\.jpeg$/, '1024x768.jpeg');
      if (!seen.has(hr)) { seen.add(hr); photos.push(hr); }
    });
  });
  // Fallback: click-through if script strategy found nothing
  if (photos.length <= 1) {
    const addV = () => document.querySelectorAll('button[aria-label^="View vehicle photo"] img').forEach(img => {
      const src = img.src?.split('?')[0].replace('296x222', '1024x768');
      if (src?.includes('cargurus.com') && !seen.has(src)) { seen.add(src); photos.push(src); }
    });
    addV();
    let prev = photos.length;
    for (let i = 0; i < 8; i++) {
      const nb = document.querySelector('button[aria-label="Next Page"]');
      if (!nb) break;
      nb.click();
      await new Promise(r => setTimeout(r, 380));
      addV();
      if (photos.length === prev) break;
      prev = photos.length;
    }
  }

  return { title, vin, price, mileage, exterior_color, interior_color, body_style, trim, photos };
}

/**
 * Injected into a CarGurus VDP background tab.
 * Polls up to 15s for the page to finish rendering, then extracts all data.
 * Must be self-contained.
 */
async function extractCarGurusVdpDataWithWait() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const h1 = document.querySelector('h1[data-cg-ft="vdp-listing-title"]');
    if (h1?.innerText?.trim()) break;
    await new Promise(r => setTimeout(r, 600));
  }

  const getSpec = (attr) =>
    document.querySelector(`[data-cg-ft="${attr}"] span:last-child`)?.textContent?.trim() || null;

  const title = document.querySelector('h1[data-cg-ft="vdp-listing-title"]')?.innerText?.trim() ||
                document.title || '';
  const vin            = getSpec('vin');
  const mileage        = getSpec('mileage');
  const exterior_color = getSpec('exteriorColor');
  const interior_color = getSpec('interiorColor');
  const body_style     = getSpec('bodyType');
  const trim           = getSpec('trim');

  let price = null;
  const priceEl = document.querySelector('[class*="priceContainer"] h2, [class*="price_1cy3t"] h2');
  if (priceEl) { const m = priceEl.textContent?.match(/\$[\d,]+/); if (m) price = m[0]; }

  // Photo collection — same dual-strategy as extractCarGurusVdpData (must be self-contained)
  const seen = new Set();
  const photos = [];
  const mainImg = document.querySelector('img[alt="Vehicle Full Photo"]');
  const mainSrc = mainImg?.src?.split('?')[0];
  if (mainSrc?.includes('cargurus.com')) { seen.add(mainSrc); photos.push(mainSrc); }
  document.querySelectorAll('script').forEach(s => {
    const matches = (s.textContent || '').match(
      /https:\/\/static\.cargurus\.com\/images\/forsale\/[^"'\\]+\.jpeg/g
    ) || [];
    matches.forEach(u => {
      const hr = u.replace(/\d+x\d+\.jpeg$/, '1024x768.jpeg');
      if (!seen.has(hr)) { seen.add(hr); photos.push(hr); }
    });
  });
  if (photos.length <= 1) {
    const addV = () => document.querySelectorAll('button[aria-label^="View vehicle photo"] img').forEach(img => {
      const src = img.src?.split('?')[0].replace('296x222', '1024x768');
      if (src?.includes('cargurus.com') && !seen.has(src)) { seen.add(src); photos.push(src); }
    });
    addV();
    let prev = photos.length;
    for (let i = 0; i < 8; i++) {
      const nb = document.querySelector('button[aria-label="Next Page"]');
      if (!nb) break;
      nb.click();
      await new Promise(r => setTimeout(r, 380));
      addV();
      if (photos.length === prev) break;
      prev = photos.length;
    }
  }

  return { title, vin, price, mileage, exterior_color, interior_color, body_style, trim, photos };
}

/**
 * Injected into a Cars.com VDP background tab.
 * Cars.com uses Phoenix LiveView — content renders asynchronously after the initial
 * HTML loads. This async function polls until the thumbnail grid (or h1 with a year)
 * appears, then extracts all vehicle data. chrome.scripting.executeScript awaits the
 * returned Promise so the caller blocks until this resolves.
 * Must be self-contained — no closure references.
 */
async function extractCarsDotComVdpDataWithWait() {
  // Cars.com sometimes shows a Cloudflare "Just a moment..." interstitial for
  // ~3s before the real VDP renders. Wait for it to clear so we don't scrape
  // the challenge page. Self-contained (this fn is injected into the page).
  async function waitForCloudflareChallenge(maxWaitMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (!document.title.includes('Just a moment')) return true;
      console.log('DealersOrbit: Cloudflare check in progress, waiting...');
      await new Promise(r => setTimeout(r, 500));
    }
    console.log('DealersOrbit: Cloudflare check did not clear within timeout');
    return false;
  }
  await waitForCloudflareChallenge();

  // Poll up to 15s for the LiveView content to render
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const thumbImgs = document.querySelectorAll('[part="thumbnail-grid"] button img');
    const h1text = document.querySelector('h1')?.innerText?.trim() || '';
    if (thumbImgs.length > 0 || /\b(19|20)\d{2}\b/.test(h1text)) break;
    await new Promise(r => setTimeout(r, 600));
  }

  // ── Title ─────────────────────────────────────────────────
  const title = document.querySelector('h1')?.innerText?.trim() || document.title || '';

  // ── VIN ───────────────────────────────────────────────────
  const vinMatch = document.body.innerText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  const vin = vinMatch ? vinMatch[1].toUpperCase() : null;

  // ── Price — prefer all-in total from price stack ──────────
  let price = null;
  const tfootAmt = document.querySelector('.price-stack-display tfoot td:last-child');
  if (tfootAmt) { const m = tfootAmt.textContent?.match(/\$[\d,]+/); if (m) price = m[0]; }
  if (!price) { const m = document.querySelector('h2.list-price')?.textContent?.match(/\$[\d,]+/); if (m) price = m[0]; }

  // ── Mileage ───────────────────────────────────────────────
  let mileage = null;
  const mileageDt = Array.from(document.querySelectorAll('dl dt'))
    .find(dt => /mileage/i.test(dt.textContent));
  if (mileageDt) {
    const m = mileageDt.nextElementSibling?.textContent?.match(/([\d,]+)\s*mi\b/i);
    if (m) mileage = parseInt(m[1].replace(/,/g, '')).toLocaleString() + ' mi';
  }

  // ── Colors from basics list ───────────────────────────────
  let exterior_color = null, interior_color = null;
  document.querySelectorAll('li[data-qa="basics-entry"]').forEach(li => {
    const text = li.textContent?.trim() || '';
    const ext  = text.match(/^(.+?)\s+exterior color$/i);
    const int_ = text.match(/^(.+?)\s+interior color$/i);
    if (ext  && !exterior_color) exterior_color = ext[1].trim();
    if (int_ && !interior_color) interior_color = int_[1].trim();
  });

  // ── Photos — only platform.cstatic-images.com vehicle photos ─
  const seen = new Set();
  const photos = [];
  document.querySelectorAll('img').forEach(img => {
    const src = (img.src || img.getAttribute('data-src') || '').replace(/\?.*$/, '');
    if (!src.includes('platform.cstatic-images.com')) return;
    if (!src.includes('/xxlarge/')) return;  // "similar vehicles" thumbnails lack /xxlarge/
    if (src.includes('/dealer_media/')) return;
    if (!seen.has(src)) { seen.add(src); photos.push(src); }
  });

  return { title, vin, price, mileage, exterior_color, interior_color, body_style: null, photos };
}

/**
 * Cars.com-specific VDP extractor — injected into the detail page tab.
 * Avoids the generic img scan and mileage-block problems on Cars.com pages.
 * Must be self-contained (no closure references).
 */
async function extractCarsDotComVdpData() {
  // Wait out the Cloudflare "Just a moment..." interstitial if present, so we
  // don't scrape the challenge page. Self-contained (injected into the page).
  async function waitForCloudflareChallenge(maxWaitMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (!document.title.includes('Just a moment')) return true;
      console.log('DealersOrbit: Cloudflare check in progress, waiting...');
      await new Promise(r => setTimeout(r, 500));
    }
    console.log('DealersOrbit: Cloudflare check did not clear within timeout');
    return false;
  }
  await waitForCloudflareChallenge();

  // ── Title ─────────────────────────────────────────────────
  const title = document.querySelector('h1')?.innerText?.trim() || document.title || '';

  // ── VIN ───────────────────────────────────────────────────
  const vinMatch = document.body.innerText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  const vin = vinMatch ? vinMatch[1].toUpperCase() : null;

  // ── Price — prefer all-in total from price-stack tfoot ────
  let price = null;
  const tfootAmt = document.querySelector('.price-stack-display tfoot td:last-child');
  if (tfootAmt) { const m = tfootAmt.textContent?.match(/\$[\d,]+/); if (m) price = m[0]; }
  if (!price) {
    const lp = document.querySelector('h2.list-price');
    const m = lp?.textContent?.match(/\$[\d,]+/);
    if (m) price = m[0];
  }

  // ── Mileage — from the mileage dl, not the whole payment block ─
  let mileage = null;
  const mileageDt = Array.from(document.querySelectorAll('dl dt'))
    .find(dt => /mileage/i.test(dt.textContent));
  if (mileageDt) {
    const dd = mileageDt.nextElementSibling;
    const m = dd?.textContent?.match(/([\d,]+)\s*mi\b/i);
    if (m) mileage = parseInt(m[1].replace(/,/g, '')).toLocaleString() + ' mi';
  }

  // ── Colors — from li[data-qa="basics-entry"] label text ───
  let exterior_color = null;
  let interior_color = null;
  document.querySelectorAll('li[data-qa="basics-entry"]').forEach(li => {
    const text = li.textContent?.trim() || '';
    const ext = text.match(/^(.+?)\s+exterior color$/i);
    const int_ = text.match(/^(.+?)\s+interior color$/i);
    if (ext && !exterior_color) exterior_color = ext[1].trim();
    if (int_ && !interior_color) interior_color = int_[1].trim();
  });

  // ── Photos — only platform.cstatic-images.com vehicle photos ─
  // Exclude /dealer_media/ paths (dealer logos, award seals, etc.)
  const seen = new Set();
  const photos = [];
  document.querySelectorAll('img').forEach(img => {
    const src = (img.src || img.getAttribute('data-src') || '').replace(/\?.*$/, '');
    if (!src.includes('platform.cstatic-images.com')) return;
    if (!src.includes('/xxlarge/')) return;  // "similar vehicles" thumbnails lack /xxlarge/
    if (src.includes('/dealer_media/')) return;
    if (!seen.has(src)) { seen.add(src); photos.push(src); }
  });

  return { title, vin, price, mileage, exterior_color, interior_color, body_style: null, photos };
}

/**
 * This function is injected into the detail page tab.
 * It runs in the context of the dealership website.
 * Must be self-contained — no references to variables outside this function.
 */
function extractDetailPageData(selectors) {
  selectors = selectors || {};

  const skipPatterns = ['thumb_', '/thumb/', 'thumbnail', 'logo', 'icon', 'badge', 'placeholder', '1x1', 'spacer',
    // carsforsale.com lazy-load placeholders (real photos live under /<hash>/<size>/…)
    'sports_car_front_view', 'carsforsale.com/images/', '/images/no_'];

  // Safe wrappers — invalid CSS selectors (e.g. jQuery :contains()) throw in querySelector
  const safeQuery    = (sel) => { try { return sel ? document.querySelector(sel) : null; } catch (e) { return null; } };
  const safeQueryAll = (sel) => { try { return sel ? Array.from(document.querySelectorAll(sel)) : []; } catch (e) { return []; } };
  // Best real image URL for an <img>: lazy-load attributes hold the REAL photo
  // while src is often a placeholder (carsforsale uses data-lazy). Check the
  // common lazy attrs before src, and take the first URL of a srcset.
  const bestImgUrl = (img) => {
    if (!img) return '';
    let u = img.getAttribute('data-lazy') || img.getAttribute('data-src') ||
            img.getAttribute('data-original') || img.getAttribute('data-lazy-src') ||
            img.getAttribute('data-srcset') || img.getAttribute('srcset') || img.src || '';
    if (u.includes(' ')) u = u.trim().split(/\s+/)[0];   // srcset → first URL
    return u.replace(/\?.*$/, '');
  };
  // Extract only the dollar amount from an element — avoids grabbing label text like "JBA Price Freight Included"
  const getPriceText = (el) => {
    if (!el) return null;
    const full = el.textContent?.trim() || '';
    const match = full.match(/\$[\d,]+/);
    return match ? match[0] : (full.length < 15 && /\d/.test(full) ? full : null);
  };

  // Generalized label→value scan. Finds an element whose text IS one of the
  // labels, then returns the adjacent value — handles <dt>/<dd>, <th>/<td>, AND
  // "<div class=label>Label</div><div class=detail>Value</div>" sibling layouts
  // (e.g. dealer.com features_snapshot) that a CSS selector can't target because
  // the value cell shares its class with unrelated items (mileage vs. "Premium
  // Sound"). `validate` optionally rejects wrong matches (e.g. mileage must be numeric).
  const scanByLabel = (labels, validate) => {
    const kws = labels.map(k => k.toLowerCase());
    const ok  = (v) => !!v && (!validate || validate(v));
    const els = document.querySelectorAll(
      'dt, th, label, .features_snapshot__label, [class*="__label"], [class*="-label"], span, div, li, td'
    );
    for (const k of kws) {                     // priority: most specific label first
      for (const el of els) {
        const t = (el.textContent || '').trim().toLowerCase().replace(/:$/, '');
        if (t !== k || t.length > 40) continue;
        // 1) next sibling element with text
        let sib = el.nextElementSibling;
        while (sib && !sib.textContent.trim()) sib = sib.nextElementSibling;
        if (sib) { const v = sib.textContent.trim().replace(/\s+/g, ' '); if (ok(v)) return v; }
        // 2) a value-ish sibling under the same parent
        if (el.parentElement) {
          const valEl = el.parentElement.querySelector('[class*="detail"],[class*="value"],dd,td');
          if (valEl && valEl !== el) { const v = valEl.textContent.trim().replace(/\s+/g, ' '); if (ok(v)) return v; }
        }
      }
    }
    return null;
  };

  // ── Trigger full carousel load ────────────────────────────
  const nextBtns = document.querySelectorAll(
    '.slick-next, [aria-label="Next Photo"], [title="Next Photo"], ' +
    '.carousel-next, .gallery-next, button[class*="next"]'
  );
  const totalSlides = document.querySelectorAll('.slick-slide:not(.slick-cloned)').length || 0;
  if (nextBtns.length > 0) {
    for (let i = 0; i < totalSlides + 2; i++) nextBtns[0].click();
  }
  safeQueryAll('img[data-src], img[data-lazy-src], img[data-lazysrc], img[data-lazy], img[data-original]').forEach(img => {
    if (img.dataset.src) img.src = img.dataset.src;
    if (img.dataset.lazySrc) img.src = img.dataset.lazySrc;
    if (img.dataset.lazysrc) img.src = img.dataset.lazysrc;
    if (img.dataset.lazy) img.src = img.dataset.lazy;         // carsforsale
    if (img.dataset.original) img.src = img.dataset.original;
  });

  // ── VIN ───────────────────────────────────────────────────
  let vin = null;
  if (selectors.vin) {
    vin = safeQuery(selectors.vin)?.textContent?.trim() || null;
    if (vin) vin = (vin.match(/[A-HJ-NPR-Z0-9]{17}/i) || [])[0] || null;
  }
  if (!vin) {
    const vinEl = safeQuery('[data-vin]') || safeQuery('.vin-value') || safeQuery('[class*="vin"]');
    vin = vinEl?.getAttribute('data-vin') || vinEl?.innerText?.match(/[A-HJ-NPR-Z0-9]{17}/i)?.[0] || null;
  }
  if (!vin) {
    vin = (document.body.innerText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/) || [])[1] || null;
  }

  // ── Title ─────────────────────────────────────────────────
  const titleEl = safeQuery('h1, .vehicle-title, [class*="vehicle-name"]');
  const titleText = titleEl?.innerText?.trim() || document.title || '';

  // ── Price ─────────────────────────────────────────────────
  let price = null;
  if (selectors.sale_price) {
    price = getPriceText(safeQuery(selectors.sale_price));
  }
  if (!price) {
    // 1. Direct selectors — final/internet price first (includes fees)
    price = getPriceText(safeQuery('dd.final-price.internetPrice .price-value')) ||
            getPriceText(safeQuery('dd[class*="internetPrice"] .price-value')) ||
            getPriceText(safeQuery('[class*="internet-price"] .price-value')) ||
            getPriceText(safeQuery('[class*="our-price"] .price-value')) ||
            getPriceText(safeQuery('[class*="selling-price"]')) ||
            getPriceText(safeQuery('[class*="final-price"]'));

    // 2. Label-scan fallback — finds final price by reading dt/th label text
    // Works for new cars where the "JBA Price Freight Included" label precedes the value
    if (!price) {
      const labels = safeQueryAll('dl dt, dl th, table tr td:first-child, table tr th:first-child');
      const FINAL_PRICE_KEYWORDS = ['freight', 'destination', 'internet price', 'jba price',
        'our price', 'online price', 'total price', 'dealer price', 'final price'];
      for (const label of labels) {
        const text = label.textContent?.toLowerCase() || '';
        if (FINAL_PRICE_KEYWORDS.some(kw => text.includes(kw))) {
          const sibling = label.nextElementSibling;
          const candidate = getPriceText(sibling?.querySelector?.('.price-value') || sibling);
          if (candidate) { price = candidate; break; }
        }
      }
    }

    // 3. Last resort — any price-value element (avoids MSRP by trying last resort only)
    if (!price) {
      price = getPriceText(safeQuery('dd.askingPrice .price-value')) ||
              getPriceText(safeQuery('[class*="sale-price"]')) ||
              getPriceText(safeQuery('.price-value')) || null;
    }
  }

  // ── Processing fee ────────────────────────────────────────
  let processingFee = null;
  if (selectors.processing_fee) {
    processingFee = getPriceText(safeQuery(selectors.processing_fee));
  }
  if (!processingFee) {
    processingFee = getPriceText(safeQuery('dd.ABCRule .price-value'));
  }

  // ── Mileage ───────────────────────────────────────────────
  // Mileage must be numeric — a shared-class selector can grab a feature name
  // ("Premium Sound", "Cruise Control"); reject any non-numeric result.
  const isMileage = (v) => /\d/.test(String(v || ''));
  let mileage = null;
  if (selectors.mileage) {
    const m = safeQuery(selectors.mileage)?.textContent?.trim() || null;
    if (isMileage(m)) mileage = m;
  }
  if (!mileage) {
    const mileageEls = safeQueryAll('.highlight-badge, [class*="mileage"], [class*="miles"]');
    mileage = mileageEls.find(el => /miles|mi\b/i.test(el.innerText))?.innerText?.trim() || null;
  }
  if (!mileage) {
    // Generalized label→value scan (dealer.com features_snapshot etc.)
    mileage = scanByLabel(['mileage', 'odometer', 'miles'], isMileage);
  }

  // ── Colors + body style ───────────────────────────────────
  let exteriorColor = null;
  let interiorColor = null;
  let bodyStyle = null;

  // Only trust a selector that matches EXACTLY ONE element — a value class shared
  // with unrelated items (features_snapshot) matches many and grabs the wrong one.
  const oneMatchText = (sel) => {
    const els = safeQueryAll(sel);
    return els.length === 1 ? (els[0].textContent?.trim() || null) : null;
  };
  if (selectors.exterior_color) {
    exteriorColor = oneMatchText(selectors.exterior_color);
  }
  if (selectors.interior_color) {
    interiorColor = oneMatchText(selectors.interior_color);
  }
  if (selectors.body_style) {
    const raw = oneMatchText(selectors.body_style);
    bodyStyle = raw ? raw.split('/')[0].trim() : null;
  }

  // JBA fallback — dl.dl-horizontal spec table (runs if any field still missing)
  if (!exteriorColor || !interiorColor || !bodyStyle) {
    let currentLabel = null;
    safeQueryAll('dl.dl-horizontal dt, dl.dl-horizontal dd').forEach(el => {
      if (el.tagName === 'DT') {
        currentLabel = el.textContent.trim().toLowerCase();
      } else if (el.tagName === 'DD') {
        if (!exteriorColor && currentLabel?.includes('exterior color')) {
          exteriorColor = el.querySelector('span:last-child')?.textContent.trim() || el.textContent.trim() || null;
        } else if (!interiorColor && currentLabel?.includes('interior color')) {
          interiorColor = el.querySelector('span:last-child')?.textContent.trim() || el.textContent.trim() || null;
        } else if (!bodyStyle && currentLabel?.includes('body')) {
          const fullText = el.querySelector('span')?.textContent.trim() || el.textContent.trim() || '';
          bodyStyle = fullText.split('/')[0].trim() || null;
        }
      }
    });
  }

  // Generalized label→value scan for label/value div layouts (features_snapshot etc.)
  if (!exteriorColor) exteriorColor = scanByLabel(['exterior color', 'exterior']);
  if (!interiorColor) interiorColor = scanByLabel(['interior color', 'interior']);
  if (!bodyStyle) {
    const b = scanByLabel(['body style', 'body type', 'body']);
    if (b) bodyStyle = b.split('/')[0].trim();  // "Hatchback/5" -> "Hatchback"
  }

  // ── Photos ────────────────────────────────────────────────
  // Run all methods and keep whichever yields the most photos

  // Method 1: config selector
  let photosBySelector = [];
  if (selectors.photos) {
    photosBySelector = safeQueryAll(selectors.photos)
      .map(bestImgUrl)   // reads data-lazy/data-src/srcset before src (lazy galleries)
      .filter(src => src && src.startsWith('http') && !skipPatterns.some(p => src.toLowerCase().includes(p)))
      .filter((src, i, arr) => arr.indexOf(src) === i)
      .slice(0, 40);
  }

  // Method 2: CDN URL extraction from raw HTML (Dealer Inspire / pictures.dealer.com)
  const html = document.documentElement.innerHTML;
  const cdnMatches = html.match(/https:\/\/pictures\.dealer\.com\/[^"'\s>\\]+/g) || [];
  const cdnSources = new Set();
  cdnMatches.forEach(url => {
    const clean = url.replace(/\\u0026.*/, '').replace(/\?.*/, '').replace(/\\.*/, '');
    if (clean && clean.match(/\.(jpg|jpeg|png|webp)$/i)) cdnSources.add(clean);
  });
  const photosByCDN = Array.from(cdnSources)
    .filter(src => !skipPatterns.some(p => src.toLowerCase().includes(p)))
    .slice(0, 40);

  // Use whichever method found more photos; fall back to generic img scan
  let photos = photosBySelector.length >= photosByCDN.length ? photosBySelector : photosByCDN;

  if (!photos.length) {
    photos = safeQueryAll('img')
      .map(bestImgUrl)   // lazy-aware
      .filter(src => src.startsWith('http') && src.match(/\.(jpg|jpeg|webp|png)/i))
      .filter(src => !skipPatterns.some(p => src.toLowerCase().includes(p)))
      .filter((src, i, arr) => arr.indexOf(src) === i)
      .slice(0, 40);
  }

  // Config-driven URL filter — some sites mix the main gallery with "similar
  // vehicles" using the same img markup, which a CSS selector can't separate.
  // If the config specifies a URL substring that only THIS car's photos contain,
  // keep just those (e.g. "imagescf.dealercenter.net/719").
  if (selectors.photos_url_include) {
    const inc = String(selectors.photos_url_include).toLowerCase();
    const filtered = photos.filter(src => src.toLowerCase().includes(inc));
    if (filtered.length) photos = filtered;
  }

  return { vin, title: titleText, photos, price, processing_fee: processingFee, mileage, exterior_color: exteriorColor, interior_color: interiorColor, body_style: bodyStyle };
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

// Registers a vehicle's listing for sold-checking (sets fb_posted). This is the
// SOLD-CHECK REGISTRATION step only — the per-channel posting EVENT is recorded
// separately (MARKETPLACE_POST_COMPLETE / FB_POST_COMPLETE / FB_GROUPS_POST_COMPLETE
// → /track-posting), so this is safe to call from all three flows without
// double-logging a marketplace event.
//
// Dedup is by VIN: the listing is matched by VIN (the row was created at import,
// which is also where its dealer-VDP listing_url — the URL the sold-checker
// actually hits — was set). If that listing is already fb_posted, we SKIP — the
// existing sold-check entry keeps getting checked; we don't create a second one,
// no matter how many channels the vehicle is posted to. `listingUrl` (the current
// page's URL) is intentionally NOT written to the listing: the dealer VDP captured
// at import always wins as the check target.
async function markListingPosted(vehicle, listingUrl) {
  const { token } = await chrome.storage.local.get("token");
  if (!token) return;

  try {
    // Find the listing in backend by VIN (fall back to year/make/model).
    const listingsResp = await fetch(`${API_BASE}/listings/`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (listingsResp.status === 401) { await handleExpiredToken(); return; }
    if (!listingsResp.ok) return;

    const listings = await listingsResp.json();
    let match = listings.find(l =>
      (vehicle?.vin && l.vin === vehicle.vin) ||
      (l.make === vehicle?.make && l.model === vehicle?.model && l.year === vehicle?.year)
    );

    // VIN dedup: already registered → skip, the existing entry keeps being checked.
    if (match && match.fb_posted) {
      console.log(`DealersOrbit: Sold-check already registered for VIN ${match.vin || vehicle?.vin} (listing ${match.id}) — skipping`);
      return;
    }

    // No backing listing yet — this happens for photos-only ads (they never hit
    // the video pipeline that calls saveToListingHistory). Create one now so the
    // posted vehicle is sold-checkable and shows up in Check Sold. Keyed by VIN,
    // storing the dealer-VDP listing_url that the sold-checker will actually hit.
    const soldCheckUrl = listingUrl || vehicle?.listing_url || null;
    if (!match) {
      if (!soldCheckUrl) {
        console.log(`DealersOrbit: No listing and no listing_url for VIN ${vehicle?.vin || 'n/a'} — cannot register sold-check`);
        return;
      }
      const createResp = await fetch(`${API_BASE}/listings/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          vin:         vehicle?.vin || null,
          year:        vehicle?.year || null,
          make:        vehicle?.make || null,
          model:       vehicle?.model || null,
          trim:        vehicle?.trim || null,
          price:       vehicle?.price || null,
          mileage:     vehicle?.mileage || null,
          listing_url: soldCheckUrl,
        }),
      });
      if (!createResp.ok) {
        console.log(`DealersOrbit: Failed to create listing for sold-check (VIN ${vehicle?.vin || 'n/a'}): ${createResp.status}`);
        return;
      }
      match = await createResp.json();
      console.log(`DealersOrbit: Created listing ${match.id} for sold-check (VIN ${match.vin || vehicle?.vin})`);
    }

    // record_event=false: this call ONLY registers the sold-check (fb_posted). The
    // channel event is logged via /track-posting by the *_POST_COMPLETE handlers.
    await fetch(`${API_BASE}/listings/${match.id}/posted?record_event=false`, {
      method: "PATCH",
      headers: { "Authorization": `Bearer ${token}` },
    });
    console.log(`DealersOrbit: Registered listing ${match.id} for sold-check (VIN ${match.vin || vehicle?.vin})`);
  } catch (err) {
    console.error("DealersOrbit: Failed to register listing for sold-check:", err);
  }
}

// Standalone — serialized and injected into detail page tab via executeScript
function extractDetailPageFallback(confirmedPriceLabel) {
  const getAll = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch (_) { return []; } };

  // ── Price ──────────────────────────────────────────────────
  let price = null;

  // 1. Use confirmed label from onboarding (most accurate)
  if (confirmedPriceLabel) {
    const labelLower = confirmedPriceLabel.toLowerCase();
    getAll('[class*="price-label"],[class*="label"],[class*="Label"],dt,th,span,strong').forEach(el => {
      if (price) return;
      if (el.textContent?.trim().toLowerCase().includes(labelLower)) {
        const container = el.closest('[class*="price-block"],[class*="pricing-item"],[class*="price-row"],tr,dd');
        const priceEl   = container?.querySelector('[class*="price"]:not([class*="label"]):not([class*="msrp"]),td:last-child') || el.nextElementSibling;
        const m = priceEl?.textContent?.match(/\$[\d,]+/);
        if (m && parseInt(m[0].replace(/[$,]/g,'')) > 1000) price = m[0];
      }
    });
  }

  // 2. Known price keywords in label elements
  if (!price) {
    const priceKeywords = ['internet price','online price','our price','sale price',
                           'final price','dealer price','advertised price'];
    getAll('dt,[class*="price-label"],[data-testid*="price-label"],span.label').forEach(el => {
      if (price) return;
      const t = el.textContent?.trim().toLowerCase() || '';
      if (!priceKeywords.some(k => t.includes(k))) return;
      const dd = el.nextElementSibling || el.closest('[class*="price-block"],[class*="pricing"]')
                   ?.querySelector('[class*="price"]:not([class*="label"])');
      const m = dd?.textContent?.match(/\$[\d,]+/);
      if (m && parseInt(m[0].replace(/[$,]/g,'')) > 1000) price = m[0];
    });
  }

  // 3. Collect all significant dollar amounts, take the median (avoids MSRP high/fees low)
  if (!price) {
    const amounts = [];
    getAll('[class*="price"],[class*="Price"]').forEach(el => {
      if (el.children.length > 3) return; // skip containers
      const m = el.textContent?.match(/\$[\d,]+/);
      if (m) { const v = parseInt(m[0].replace(/[$,]/g,'')); if (v > 1000 && v < 300000) amounts.push(v); }
    });
    if (amounts.length) {
      amounts.sort((a,b) => a-b);
      price = '$' + amounts[Math.floor(amounts.length / 2)].toLocaleString();
    }
  }

  // ── Mileage ────────────────────────────────────────────────
  let mileage = null;
  // Spec containers: dl.dl-horizontal, .basic-info, table, [class*="spec"]
  const specContainers = [
    ...getAll('dl.dl-horizontal dt, dl dt'),
    ...getAll('[class*="spec"] dt, [class*="spec"] th, [class*="detail"] dt'),
    ...getAll('table.vehicle-specs th, table th'),
    ...getAll('[data-testid*="mileage"]'),
  ];
  specContainers.forEach(el => {
    if (mileage) return;
    const t = el.textContent?.trim().toLowerCase() || '';
    if (!['mileage','miles','odometer'].some(k => t.includes(k))) return;
    const val = (el.nextElementSibling || el.closest('tr')?.querySelector('td'))?.textContent?.trim() || '';
    const m = val.match(/([\d,]+)/);
    if (m && parseInt(m[1].replace(/,/g,'')) > 100) mileage = parseInt(m[1].replace(/,/g,'')).toLocaleString() + ' mi';
  });
  // Inline elements with "miles" in text
  if (!mileage) {
    getAll('[class*="mileage"],[class*="Mileage"],[data-testid*="mileage"]').forEach(el => {
      if (mileage) return;
      const m = el.textContent?.match(/([\d,]+)\s*(mi|miles)/i);
      if (m) mileage = parseInt(m[1].replace(/,/g,'')).toLocaleString() + ' mi';
    });
  }

  // ── Colors — only look in known spec containers ────────────
  let exterior_color = null, interior_color = null;
  const specLabelEls = [
    ...getAll('dl.dl-horizontal dt, dl dt'),
    ...getAll('[class*="spec"] dt, [class*="spec-label"], [class*="detail"] dt'),
    ...getAll('table th, [class*="label"]'),
  ];
  specLabelEls.forEach(el => {
    const t = el.textContent?.trim().toLowerCase().replace(/[:\s]+$/,'') || '';
    const valEl = el.nextElementSibling || el.closest('tr')?.querySelector('td:last-child');
    const val   = valEl?.textContent?.trim();
    if (!val || val.length > 35 || val.includes('\n')) return;
    if (!exterior_color && ['exterior color','exterior','ext color','ext. color'].some(k => t === k))
      exterior_color = val;
    if (!interior_color && ['interior color','interior','int color','int. color'].some(k => t === k))
      interior_color = val;
  });

  // Mileage: JSON-LD structured data (most reliable — always present, pre-rendered)
  if (!mileage) {
    document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      if (mileage) return;
      try {
        const data = JSON.parse(el.textContent || '{}');
        const items = Array.isArray(data) ? data : [data];
        items.forEach(item => {
          if (mileage) return;
          const raw = item.mileageFromOdometer?.value ?? item.mileageFromOdometer ?? item.odometer;
          if (raw != null) {
            const v = parseInt(String(raw).replace(/,/g,''));
            if (v > 100 && v < 500000) mileage = v.toLocaleString() + ' mi';
          }
        });
      } catch (_) {}
    });
  }

  // Mileage: label+number pattern in body text ("Mileage: 112,000" without trailing unit)
  if (!mileage) {
    const bodyText = document.body?.innerText || '';
    const m1 = bodyText.match(/(?:mileage|odometer)[:\s]+\s*([\d,]{4,9})/i);
    const m2 = bodyText.match(/\b([\d,]{4,9})\s*(?:miles|mi)\b/i);
    const raw = m1?.[1] || m2?.[1];
    if (raw) {
      const v = parseInt(raw.replace(/,/g,''));
      if (v > 100 && v < 500000) mileage = v.toLocaleString() + ' mi';
    }
  }

  return { price, mileage, exterior_color, interior_color, body_style: null };
}

const JUNK_PHOTO_PATTERNS = [
  'playbutton', 'tradepending', 'sticker-grey', 'autocheck', 'calendar',
  'gravityforms', 'autoipacket', 'logo', 'icon', 'badge', 'placeholder',
  'pixel', 'tracking', '1x1', 'spacer', '.gif', 'data:image',
];

function filterJunkPhotos(urls) {
  return (urls || []).filter(url => {
    if (!url || !url.startsWith('http')) return false;
    const lower = url.toLowerCase();
    return !JUNK_PHOTO_PATTERNS.some(p => lower.includes(p));
  });
}

function normalizeBodyStyle(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes('suv') || lower.includes('sport utility') || lower.includes('crossover')) return 'SUV';
  if (lower.includes('pickup') || lower.includes('truck')) return 'Truck';
  if (lower.includes('minivan') || lower.includes('van')) return 'Van';
  if (lower.includes('convertible') || lower.includes('cabriolet')) return 'Convertible';
  if (lower.includes('coupe')) return 'Coupe';
  if (lower.includes('hatchback')) return 'Hatchback';
  if (lower.includes('wagon') || lower.includes('estate')) return 'Wagon';
  if (lower.includes('sedan')) return 'Sedan';
  return raw;
}

function applyNhtsaToVehicle(vehicle, vehicleDataStr) {
  if (!vehicle || !vehicleDataStr) return;
  let vd;
  try { vd = JSON.parse(vehicleDataStr); } catch (_) { return; }
  if (!vd || typeof vd !== 'object') return;

  if (!vehicle.year  && vd.year)  vehicle.year  = vd.year;
  if (!vehicle.make  && vd.make)  vehicle.make  = vd.make;
  if (!vehicle.model && vd.model) vehicle.model = vd.model;
  if ((!vehicle.trim || isGenericCardText(vehicle.trim)) && vd.trim) vehicle.trim = vd.trim;
  if (!vehicle.body_style && vd.body_style) vehicle.body_style = normalizeBodyStyle(vd.body_style);
  if (vd.drivetrain) vehicle.drivetrain = vd.drivetrain;
  if (vd.fuel_type)  vehicle.fuel_type  = vd.fuel_type;
  if (vd.engine)     vehicle.engine     = vd.engine;
}

function parseYearMakeModelFromTitle(title) {
  if (!title) return {};
  const yearMatch = title.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch?.[0] || null;
  const rest = title
    .replace(/\s+in\s+[^,]+,\s*[A-Za-z]{2}\b.*$/i, '')  // strip " in City, ST" location suffix
    .replace(/\b(19|20)\d{2}\b/, '')
    .replace(/\b(pre-?owned|used|new|certified|cpo)\b/gi, '')
    .trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  // model = one word (e.g. "F-150"), rest becomes trim ("XLT")
  return {
    year,
    make:  parts[0] || null,
    model: parts[1] || null,
  };
}

// Returns true for generic UI / widget text that a bad card selector might scrape
function isGenericCardText(text) {
  if (!text) return true;
  // Any "Label: value" or "Label: number" pattern is widget text, not a real field value
  if (/:\s*\d/.test(text) || /:\s*\w+/.test(text) && text.length > 20) return true;
  const generic = [
    'compare', 'pre-owned', 'value your trade', 'get quote',
    'view details', 'learn more', 'contact', 'schedule',
    'vehicles in market', 'percent of', 'recently sold', 'market analysis',
    'trade-in', 'trade in', 'financing', 'calculate payment',
    'total merits', 'merits', 'market days',
  ];
  return generic.some(g => text.toLowerCase().includes(g));
}

function parseTrimFromTitle(title, year, make, model) {
  if (!title) return null;
  let trim = title.replace(/\s+in\s+[^,]+,\s*[A-Za-z]{2}\b.*$/i, '');  // strip " in City, ST"
  if (year)  trim = trim.replace(year, '');
  if (make)  trim = trim.replace(new RegExp(make, 'gi'), '');
  if (model) trim = trim.replace(new RegExp(model.replace(/[-/]/g,'\\$&'), 'gi'), '');
  // Strip common prefixes and non-trim words
  trim = trim.replace(/\b(pre-?owned|pre owned|used|new|certified|cpo|vehicle)\b/gi, '');
  trim = trim.trim().replace(/\s+/g, ' ');
  // Discard if only transmission/drivetrain info remains — not a meaningful trim
  const notTrim = /^(automatic|manual|cvt|dct|awd|fwd|4wd|4x4|rwd|2wd|suv|sedan|truck|coupe|wagon)$/i;
  if (notTrim.test(trim)) return null;
  return trim || null;
}


// ── Queue management ──────────────────────────────────────────

// Serialize all addToQueue calls so rapid QUEUE_REVIEWED messages
// don't race each other and overwrite the same storage slot.
async function drainGenQueueAdditions() {
  if (isAddingToGenQueue) return;
  isAddingToGenQueue = true;
  while (genQueueAdditions.length > 0) {
    const { vehicle, videoType, theme, customScript, outroVideoId, language } =
      genQueueAdditions.shift();
    try {
      await addToQueue(vehicle, videoType, theme, customScript, outroVideoId, language);
    } catch (err) {
      console.error("DealersOrbit: addToQueue failed:", err);
    }
  }
  isAddingToGenQueue = false;
}

async function addToQueue(vehicle, videoType = "slideshow", theme = "family", customScript = null, outroVideoId = null, language = 'en') {
  const { queue = [], defaultTheme = "family" } =
    await chrome.storage.local.get(["queue", "defaultTheme"]);

  // Prevent duplicate VINs
  if (vehicle.vin) {
    const alreadyQueued = queue.some(j =>
      j.vehicle.vin === vehicle.vin &&
      j.status !== "completed" &&
      j.status !== "failed"
    );
    if (alreadyQueued) {
      console.log(`DealersOrbit: VIN ${vehicle.vin} already in queue, skipping.`);
      return queue.length;
    }
  }

  // Photos-only: no video pipeline needed — mark complete immediately
  const photosOnly = videoType === "photos";

  // Trial gate: photos-only listings never hit the backend, so the pipeline's
  // trial check can't catch them. Enforce the same limit here from the cached
  // subscription status — otherwise a trial user who's out of videos could
  // keep creating photo listings for free.
  const trialBlock = await getTrialBlockReason();  // null | 'TRIAL_VIDEO_LIMIT' | 'TRIAL_EXPIRED'

  const job = {
    id: Date.now().toString(),
    vehicle: vehicle,
    video_type: videoType,
    outro_video_id: outroVideoId,
    status: trialBlock ? "failed" : (photosOnly ? "completed" : "waiting"),
    custom_script: customScript || null,
    theme: theme,
    language: language || 'en',
    added_at: new Date().toISOString(),
    progress: trialBlock ? 0 : (photosOnly ? 100 : 0),
    label: trialBlock
      ? (trialBlock === 'TRIAL_EXPIRED' ? "Trial expired" : "Trial limit reached")
      : (photosOnly ? "Photos ready — Post to FB" : "Waiting..."),
    error: trialBlock,
    result_url: null,
  };

  queue.push(job);
  await chrome.storage.local.set({ queue });
  // Drop the cached subscription status so the popup's trial usage indicator
  // refetches a fresh count on its next render tick.
  if (trialBlock) await chrome.storage.local.remove('subscription_cache');
  if (!photosOnly && !trialBlock) processQueue();
  return queue.length;
}

async function processQueue() {
  let job = null;
  let queue = null;

  // ── Claim step (mutex-guarded) ────────────────────────────────
  // The mutex covers ONLY claiming the next job: find a waiting job, mark it
  // `generating`, and persist. Set synchronously before any await, so two
  // concurrent entries can't both claim the same job (which caused duplicate
  // submits → duplicate renders). It is released BEFORE the long poll, so a
  // stalled/slow job never holds the lock and blocks the rest of the queue.
  if (isProcessingQueue) {
    console.log('DealersOrbit: processQueue claim in progress — skipping re-entry');
    return;
  }
  isProcessingQueue = true;
  try {
    const r = await chrome.storage.local.get("queue");
    queue = r.queue || [];

    // A job is already mid-flight (serial queue — one at a time). Make sure it's
    // being polled (resumePolling no-ops if realProcessing/resume already is via
    // resumingJobIds), then stop — do NOT start another.
    const generatingJob = queue.find(j => j.status === "generating");
    if (generatingJob) {
      if (generatingJob.api_job_id) resumePolling(generatingJob, queue);
      return;
    }

    job = queue.find(j => j.status === "waiting");
    if (!job) return;

    job.status = "generating";
    await saveQueue(queue);
    console.log(`DealersOrbit: Processing — ${job.vehicle.year} ${job.vehicle.make} ${job.vehicle.model}`);
  } finally {
    isProcessingQueue = false;
  }

  // ── Submit + poll (OUTSIDE the mutex) ─────────────────────────
  // Registered in resumingJobIds so a concurrent resumePolling for the same job
  // no-ops (prevents a second poller → second continuation → double-start).
  resumingJobIds.add(job.id);
  try {
    await realProcessing(job, queue);
    if (job.status !== "completed") {
      job.status = "completed";
      job.progress = 100;
      job.label = "Complete!";
    }
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
  } finally {
    resumingJobIds.delete(job.id);
  }

  await saveQueue(queue);
  processQueue();  // continue with the next waiting job
}

async function saveToListingHistory(job, apiJob, token) {
  try {
    const v = job.vehicle;
    await fetch(`${API_BASE}/listings/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        job_id: job.api_job_id,
        vin: v.vin,
        year: v.year,
        make: v.make,
        model: v.model,
        trim: v.trim,
        price: v.price,
        mileage: v.mileage,
        body_style: v.body_style || null,
        listing_url: v.listing_url,
        video_url: apiJob.final_video_url,
        photo_urls: JSON.stringify(v.photos_for_video || []),
      }),
    });
    console.log("DealersOrbit: Saved listing to history");
  } catch (err) {
    console.error("DealersOrbit: Failed to save listing history:", err);
  }
}

async function resumePolling(job, queue) {
  if (resumingJobIds.has(job.id)) {
    console.log('DealersOrbit: Already resuming poll for job', job.id);
    return;
  }
  resumingJobIds.add(job.id);

  const { token } = await chrome.storage.local.get('token');
  if (!token) {
    resumingJobIds.delete(job.id);
    return;
  }

  const POLL_INTERVAL = 5000;   // 5s — snappier pickup of completed jobs
  const MAX_WAIT      = 1200000; // 20 minutes
  let elapsed         = 0;

  console.log('DealersOrbit: Resuming polling for job', job.id, 'api_job_id:', job.api_job_id);

  try {
    while (elapsed < MAX_WAIT) {
      await sleep(POLL_INTERVAL);
      elapsed += POLL_INTERVAL;

      try {
        const resp = await fetch(`${API_BASE}/jobs/${job.api_job_id}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!resp.ok) continue;

        const pollData = await resp.json();

        const statusMap = {
          'pending':           { progress: 5,   label: 'Starting pipeline...' },
          'vin_decoding':      { progress: 15,  label: 'Decoding VIN...' },
          'script_generating': { progress: 35,  label: 'Writing ad script...' },
          'voice_cloning':     { progress: 55,  label: 'Cloning voice...' },
          'assembling':        { progress: 80,  label: 'Assembling video...' },
          'completed':         { progress: 100, label: 'Complete!' },
          'failed':            { progress: 0,   label: pollData.error_message || 'Failed' },
        };

        const mapped = statusMap[pollData.status] || { progress: job.progress, label: job.label };
        job.progress = mapped.progress;
        job.label    = mapped.label;
        await saveQueue(queue);

        if (pollData.status === 'completed') {
          job.result_url = pollData.final_video_url;
          job.status     = 'completed';
          job.progress   = 100;
          job.label      = 'Complete!';
          applyNhtsaToVehicle(job.vehicle, pollData.vehicle_data);
          await saveQueue(queue);
          await saveToListingHistory(job, pollData, token);
          // Trial video count changed on the backend — drop the cache so the
          // popup's trial usage indicator refetches a fresh count.
          await chrome.storage.local.remove('subscription_cache');
          processQueue();
          return;
        }

        if (pollData.status === 'failed') {
          const errorMsg = pollData.error_message || '';
          if (errorMsg === 'TRIAL_VIDEO_LIMIT') {
            job.status = 'failed';
            job.error  = 'TRIAL_VIDEO_LIMIT';
            job.label  = 'Trial limit reached';
          } else if (errorMsg === 'TRIAL_EXPIRED') {
            job.status = 'failed';
            job.error  = 'TRIAL_EXPIRED';
            job.label  = 'Trial expired';
          } else {
            job.status = 'failed';
            job.error  = errorMsg || 'Generation failed';
            job.label  = 'Failed';
          }
          if (job.error === 'TRIAL_VIDEO_LIMIT' || job.error === 'TRIAL_EXPIRED') {
            await chrome.storage.local.remove('subscription_cache');
          }
          await saveQueue(queue);
          processQueue();
          return;
        }

      } catch (err) {
        console.error('DealersOrbit: Resume poll error:', err);
      }
    }

    // Timed out
    job.status = 'failed';
    job.error  = 'Timed out waiting for video. Check back later.';
    await saveQueue(queue);
  } finally {
    resumingJobIds.delete(job.id);
  }
}

async function realProcessing(job, queue) {
  // Snapshot vehicle data at start — prevents mutation from concurrent operations
  const jobSnapshot = JSON.parse(JSON.stringify(job));

  const { token } = await chrome.storage.local.get("token");
  console.log("DealersOrbit: realProcessing started, token:", !!token);

  if (!token) {
    throw new Error("Not logged in — please sign in via the extension popup.");
  }

  const v = jobSnapshot.vehicle;

  // ── Submit the job to DealersOrbit backend ──────────────────
  const jobPayload = {
    vin: v.vin || null,
    listing_url: v.listing_url || null,
    theme: jobSnapshot.theme || "family",
    video_type: jobSnapshot.video_type || "slideshow",
    outro_video_id: jobSnapshot.outro_video_id || null,
    car_photo_urls: v.photos_for_video?.length
      ? JSON.stringify(v.photos_for_video)
      : null,
    custom_script: jobSnapshot.custom_script || null,
    price: v.price || null,
    language: jobSnapshot.language || 'en',
  };

  console.log("DealersOrbit: Sending job to backend:", {
    custom_script: jobSnapshot.custom_script?.slice(0, 50),
    theme: jobSnapshot.theme,
    video_type: jobSnapshot.video_type,
  });

  const createResp = await fetch(`${API_BASE}/jobs/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(jobPayload),
  });

  if (!createResp.ok) {
    if (createResp.status === 401) await handleExpiredToken();
    const err = await createResp.json().catch(() => ({}));
    throw new Error(err.detail || `API error: ${createResp.status}`);
  }

  const apiJob = await createResp.json();
  const apiJobId = apiJob.id;

  job.api_job_id = apiJobId;
  job.label = "Job created, pipeline starting...";
  job.progress = 5;
  await saveQueue(queue);

  // ── Poll until complete ──────────────────────────────────
  const POLL_INTERVAL = 5000;   // 5 seconds
  const MAX_WAIT = 600000; // 10 minutes
  let elapsed = 0;

  while (elapsed < MAX_WAIT) {
    await sleep(POLL_INTERVAL);
    elapsed += POLL_INTERVAL;

    const pollResp = await fetch(`${API_BASE}/jobs/${apiJobId}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });

    if (pollResp.status === 401) { await handleExpiredToken(); throw new Error("Session expired"); }
    if (!pollResp.ok) continue;

    const pollData = await pollResp.json();

    const statusMap = {
      "pending":           { progress: 5,   label: "Starting pipeline..." },
      "vin_decoding":      { progress: 15,  label: "Decoding VIN..." },
      "script_generating": { progress: 35,  label: "Writing ad script..." },
      "voice_cloning":     { progress: 55,  label: "Cloning voice..." },
      "assembling":        { progress: 80,  label: "Assembling video..." },
      "completed":         { progress: 100, label: "Complete!" },
      "failed":            { progress: 0,   label: pollData.error_message || "Failed" },
    };

    const mapped = statusMap[pollData.status] || { progress: job.progress, label: job.label };
    job.progress = mapped.progress;
    job.label = mapped.label;
    await saveQueue(queue);

    if (pollData.status === "completed") {
      job.result_url = pollData.final_video_url;
      job.status = "completed";
      job.progress = 100;
      job.label = "Complete!";
      applyNhtsaToVehicle(job.vehicle, pollData.vehicle_data);
      await saveQueue(queue);
      await saveToListingHistory(jobSnapshot, pollData, token);
      // Trial video count changed on the backend — drop the cache so the
      // popup's trial usage indicator refetches a fresh count.
      await chrome.storage.local.remove("subscription_cache");
      return;
    }

    if (pollData.status === "failed") {
      const errorMsg = pollData.error_message || "";
      if (errorMsg === "TRIAL_VIDEO_LIMIT") {
        job.status = "failed";
        job.error  = "TRIAL_VIDEO_LIMIT";
        job.label  = "Trial limit reached";
      } else if (errorMsg === "TRIAL_EXPIRED") {
        job.status = "failed";
        job.error  = "TRIAL_EXPIRED";
        job.label  = "Trial expired";
      } else {
        job.status = "failed";
        job.error  = errorMsg || "Pipeline failed.";
        job.label  = "Failed";
      }
      if (job.error === "TRIAL_VIDEO_LIMIT" || job.error === "TRIAL_EXPIRED") {
        await chrome.storage.local.remove("subscription_cache");
      }
      await saveQueue(queue);
      throw new Error(errorMsg || "Pipeline failed.");
    }
  }
}

// ── Sold indicators (generic + per-dealership) ────────────────
const GENERIC_SOLD_INDICATORS = [
  'this vehicle has been sold',
  'vehicle is no longer available',
  'no longer available',
  'vehicle sold',
  'page not found',
];

function getSoldIndicatorsForUrl(url) {
  try {
    const domain = new URL(url).hostname;
    if (domain.includes('cars.com')) {
      return [
        'listing is no longer available',
        'vehicle is no longer available',
        'this vehicle has been sold',
        'listing not found',
      ];
    }
    const config = DEALERSHIP_CONFIGS[domain] || DEALERSHIP_CONFIGS['www.' + domain];
    return config?.sold_indicators || GENERIC_SOLD_INDICATORS;
  } catch {
    return GENERIC_SOLD_INDICATORS;
  }
}

async function checkListingUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);

    if (resp.status === 404 || resp.status === 410) {
      // Confirm with a second request to avoid false positives from transient errors
      await sleep(3000);
      const confirm = await fetch(url, { redirect: 'follow' });
      if (confirm.status === 404 || confirm.status === 410) {
        return { sold: true, reason: `${resp.status} confirmed` };
      }
      return { sold: false, reason: `${resp.status} then ${confirm.status} — not confirmed` };
    }

    if (resp.status === 200) {
      // Cars.com redirects sold VDPs to search results — detect via final URL
      if (url.includes('cars.com/vehicledetail/') && !resp.url.includes('/vehicledetail/')) {
        return { sold: true, reason: 'cars.com: redirected away from VDP' };
      }

      const text = await resp.text();
      const indicators = getSoldIndicatorsForUrl(url);
      const matched = indicators.find(i => text.includes(i));
      return matched
        ? { sold: true,  reason: `indicator: ${matched}` }
        : { sold: false, reason: 'active' };
    }

    return { sold: false, reason: `skipped (${resp.status})` };

  } catch (err) {
    clearTimeout(timeout);
    return { sold: false, reason: err.name === 'AbortError' ? 'timeout' : `error: ${err.message}` };
  }
}

// ── Daily sold vehicle checker ────────────────────────────────
// force=true bypasses the 6-hour throttle (used by popup manual check)
async function runDailySoldCheck(force = false) {
  const { token, last_sold_check } =
    await chrome.storage.local.get(['token', 'last_sold_check']);

  if (!token) return { sold_ids: [] };

  const now      = Date.now();
  const sixHours = 6 * 60 * 60 * 1000;
  if (!force && last_sold_check && now - last_sold_check < sixHours) {
    console.log('DealersOrbit: Sold check skipped — ran recently');
    return { sold_ids: [] };
  }

  try {
    console.log('DealersOrbit: Running sold check from extension...');

    const listingsResp = await fetch(`${API_BASE}/listings/`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (listingsResp.status === 401) { await handleExpiredToken(); return { sold_ids: [] }; }
    if (!listingsResp.ok) return { sold_ids: [] };

    const listings = await listingsResp.json();
    const toCheck = listings.filter(l => l.fb_posted && !l.is_sold && l.listing_url);

    if (toCheck.length === 0) {
      console.log('DealersOrbit: No active posted listings to check');
      await chrome.storage.local.set({ last_sold_check: now });
      return { sold_ids: [] };
    }

    console.log(`DealersOrbit: Checking ${toCheck.length} listings for sold status`);

    const soldIds    = [];
    const checkedIds = [];

    for (const listing of toCheck) {
      const result = await checkListingUrl(listing.listing_url);
      console.log(`DealersOrbit: Listing ${listing.id} (${listing.year} ${listing.make} ${listing.model}) — ${result.reason}`);

      if (result.reason === 'timeout' || result.reason.startsWith('error')) continue;

      checkedIds.push(listing.id);
      if (result.sold) soldIds.push(listing.id);

      await sleep(1000);
    }

    // Report results to backend
    if (checkedIds.length > 0) {
      const reportResp = await fetch(`${API_BASE}/listings/update-sold-status`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ sold_ids: soldIds, checked_ids: checkedIds }),
      });
      if (!reportResp.ok) {
        console.log('DealersOrbit: Failed to report sold status:', reportResp.status);
      }
    }

    if (soldIds.length > 0) {
      console.log(`DealersOrbit: ${soldIds.length} vehicle(s) detected as sold!`);

      const { sold_notifications = [] } = await chrome.storage.local.get('sold_notifications');
      const newSold = soldIds.filter(id => !sold_notifications.includes(id));

      if (newSold.length > 0) {
        await chrome.storage.local.set({
          sold_notifications: [...sold_notifications, ...newSold]
        });
        chrome.action.setBadgeText({ text: '🔴' });
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
      }
    } else {
      console.log('DealersOrbit: All posted listings still active');
    }

    await chrome.storage.local.set({ last_sold_check: now });
    return { sold_ids: soldIds };

  } catch (err) {
    console.error('DealersOrbit: Sold check error:', err);
    return { sold_ids: [] };
  }
}

// Run on startup and every 6 hours
runDailySoldCheck();
setInterval(runDailySoldCheck, 6 * 60 * 60 * 1000);

async function saveQueue(localQueue) {
  // Re-read storage and merge so we never overwrite jobs added by concurrent addToQueue calls.
  // processQueue holds a stale local array; without this merge it would wipe cars 2, 3, etc.
  const { queue: stored = [] } = await chrome.storage.local.get("queue");
  const merged = stored.map(storedJob => {
    const updated = localQueue.find(j => j.id === storedJob.id);
    return updated || storedJob;
  });
  await chrome.storage.local.set({ queue: merged });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}