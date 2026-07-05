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

// ── Message handler ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "GET_CONFIG") {
    (async () => {
      const domain = message.domain;

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

      // 1. Check backend for AI-generated active config (always hits prod — configs live on EC2)
      try {
        const configUrl = `https://api.dealersorbit.com/api/v1/dealer-configs/domain/${domain}`;
        console.log(`DealersOrbit: Fetching backend config from ${configUrl}`);
        const resp = await fetch(configUrl);
        const data = await resp.json();
        console.log(`DealersOrbit: Backend response:`, data.found, data.platform);
        if (resp.ok && data.found && data.config) {
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

        // POST to backend
        const resp = await fetch(`${API_BASE}/dealer-configs/generate-from-html`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ card_html: cardData.card_html, detail_html: detailHtml, source_url: tab.url }),
        });

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
    console.log("DealersOrbit: Received vehicle, fetching detail page...", message.vehicle);
    const vehicle = message.vehicle;
    // Pass source tab ID for VDP imports so enrichment can run on the current tab
    if (vehicle.vdp_import && sender?.tab?.id) {
      vehicle._source_tab_id = sender.tab.id;
    }
    enrichAndQueue(vehicle)
      .then(result => sendResponse({ success: true, queueLength: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
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
          results.push({ url, ok: true, buffer, contentType, isVideo });
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

  return true;
});

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

let isClassifying = false;
const classifyQueue = [];

let isAddingToGenQueue = false;
const genQueueAdditions = [];

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

async function enrichSingleVehicle(vehicle) {
  console.log("DealersOrbit: enrichSingleVehicle:", vehicle.model);
  console.log("DealersOrbit: listing_url:", vehicle.listing_url);

  // VDP imports: user is already on the detail page — run extractDetailPageData
  // on the source tab instead of opening a new one
  if (vehicle.vdp_import) {
    console.log("DealersOrbit: VDP import — extracting from source tab");

    let detailPageSelectors = {};
    let photoHintsFromConfig = null;

    if (vehicle.listing_url) {
      try {
        const domain = new URL(vehicle.listing_url).hostname;
        const cfgResp = await fetch(`https://api.dealersorbit.com/api/v1/dealer-configs/domain/${domain}`);
        if (cfgResp.ok) {
          const cfgData = await cfgResp.json();
          if (cfgData.found && cfgData.config) {
            if (cfgData.config.detail_page) detailPageSelectors = cfgData.config.detail_page;
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
        const results = await chrome.scripting.executeScript({
          target: { tabId: vehicle._source_tab_id },
          func:   extractDetailPageData,
          args:   [detailPageSelectors],
        });
        const detailData = results?.[0]?.result;
        console.log(`DealersOrbit: VDP detail data:`, detailData);
        if (detailData && !detailData._error) {
          vehicle.vin           = detailData.vin           || vehicle.vin;
          vehicle.price         = detailData.price         || vehicle.price;
          vehicle.mileage       = detailData.mileage       || vehicle.mileage;
          vehicle.exterior_color = detailData.exterior_color || null;
          vehicle.interior_color = detailData.interior_color || null;
          vehicle.body_style    = detailData.body_style    || null;
          if ((detailData.photos?.length || 0) > (vehicle.photos?.length || 0)) {
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

    vehicle.photos_for_video = applyPhotoHints(vehicle.photos || [], photoHintsFromConfig);
    console.log(`DealersOrbit: VDP selected ${vehicle.photos_for_video.length} photos`);

  } else {

  // ── Resolve config for this domain (one fetch, used for both selectors + photo hints) ──
  let detailPageSelectors = {};
  let photoHintsFromConfig = null;
  if (vehicle.listing_url) {
    try {
      const domain = new URL(vehicle.listing_url).hostname;

      // Backend config first
      const cfgResp = await fetch(
        `https://api.dealersorbit.com/api/v1/dealer-configs/domain/${domain}`
      );
      if (cfgResp.ok) {
        const cfgData = await cfgResp.json();
        if (cfgData.found && cfgData.config) {
          if (cfgData.config.detail_page) {
            detailPageSelectors = cfgData.config.detail_page;
            console.log(`DealersOrbit: Using backend detail selectors for ${domain}`);
          }
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
        // Verify data matches expected vehicle before using it
        const titleMatch = !detailData.title ||
          detailData.title.toLowerCase().includes(vehicle.model?.toLowerCase().split(' ')[0]) ||
          detailData.title.toLowerCase().includes(vehicle.make?.toLowerCase()) ||
          detailData.title.toLowerCase().includes(vehicle.year);

        if (!titleMatch) {
          console.warn(`DealersOrbit: Title mismatch! Expected ${vehicle.model}, got ${detailData.title}. Skipping detail data.`);
        } else {
          vehicle.vin     = detailData.vin     || vehicle.vin;
          vehicle.price   = detailData.price   || vehicle.price;
          vehicle.mileage = detailData.mileage || vehicle.mileage;

          if (detailData.photos?.length > (vehicle.photos?.length || 0)) {
            vehicle.photos = detailData.photos;
            console.log(`DealersOrbit: Got ${detailData.photos.length} full photos`);
          }

          if (!vehicle.trim && detailData.title) {
            vehicle.trim = parseTrimFromTitle(
              detailData.title, vehicle.year, vehicle.make, vehicle.model
            );
          }

          vehicle.exterior_color = detailData.exterior_color || null;
          vehicle.interior_color = detailData.interior_color || null;
          // JBA body style is more specific than NHTSA — prefer it
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

      // Apply photo hints — already resolved above, no second fetch needed
      vehicle.photos_for_video = applyPhotoHints(vehicle.photos || [], photoHintsFromConfig);
      console.log(`DealersOrbit: Selected ${vehicle.photos_for_video.length} photos using hints`);

    } catch (err) {
      console.error("DealersOrbit: Detail page scrape failed:", err);
    } finally {
      if (tab) {
        try { await chrome.tabs.remove(tab.id); } catch (e) { }
      }
    }
  }

  } // end else (non-VDP)

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

  while (classifyQueue.length > 0) {
    const { vehicle, queueItemId } = classifyQueue.shift();
    try {
      await classifySingleVehicle(vehicle, queueItemId);
    } catch (err) {
      console.error("DealersOrbit: Classification failed for", vehicle.model, err);
    }
  }

  isClassifying = false;
}

async function classifySingleVehicle(vehicle, queueItemId) {
  const hintPhotos = vehicle.photos_for_video || [];
  const allPhotos  = vehicle.photos || [];

  const photosToClassify = [...new Set([
    ...allPhotos.slice(0, 5),
    ...hintPhotos,
  ])].slice(0, 30);

  if (!photosToClassify.length) return;

  const { token } = await chrome.storage.local.get("token");
  if (!token) return;

  try {
    const resp = await fetch(`${API_BASE}/photos/classify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ photo_urls: photosToClassify }),
    });

    if (resp.status === 401) { await handleExpiredToken(); return; }
    if (!resp.ok) return;

    const classified = await resp.json();

    // Rescue first photo into exterior if Claude missed it
    const firstPhoto = allPhotos[0];
    if (firstPhoto && !classified.exterior?.includes(firstPhoto)) {
      classified.other     = (classified.other     || []).filter(u => u !== firstPhoto);
      classified.interior  = (classified.interior  || []).filter(u => u !== firstPhoto);
      classified.additional = (classified.additional || []).filter(u => u !== firstPhoto);
      classified.exterior  = [firstPhoto, ...(classified.exterior || [])];
    }

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
  }
}

/**
 * This function is injected into the detail page tab.
 * It runs in the context of the dealership website.
 * Must be self-contained — no references to variables outside this function.
 */
function extractDetailPageData(selectors) {
  selectors = selectors || {};

  const skipPatterns = ['thumb_', '/thumb/', 'thumbnail', 'logo', 'icon', 'badge', 'placeholder', '1x1', 'spacer'];

  // Safe wrappers — invalid CSS selectors (e.g. jQuery :contains()) throw in querySelector
  const safeQuery  = (sel) => { try { return sel ? document.querySelector(sel) : null; } catch (e) { return null; } };
  const safeQueryAll = (sel) => { try { return sel ? Array.from(document.querySelectorAll(sel)) : []; } catch (e) { return []; } };

  // ── Trigger full carousel load ────────────────────────────
  const nextBtns = document.querySelectorAll(
    '.slick-next, [aria-label="Next Photo"], [title="Next Photo"], ' +
    '.carousel-next, .gallery-next, button[class*="next"]'
  );
  const totalSlides = document.querySelectorAll('.slick-slide:not(.slick-cloned)').length || 0;
  if (nextBtns.length > 0) {
    for (let i = 0; i < totalSlides + 2; i++) nextBtns[0].click();
  }
  safeQueryAll('img[data-src], img[data-lazy-src], img[data-lazysrc]').forEach(img => {
    if (img.dataset.src) img.src = img.dataset.src;
    if (img.dataset.lazySrc) img.src = img.dataset.lazySrc;
    if (img.dataset.lazysrc) img.src = img.dataset.lazysrc;
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
    price = safeQuery(selectors.sale_price)?.textContent?.trim() || null;
  }
  if (!price) {
    // Try final/internet price first (includes processing fee) then asking price
    price = safeQuery('dd.final-price.internetPrice .price-value')?.textContent?.trim() ||
            safeQuery('[class*="internet-price"] .price-value')?.textContent?.trim() ||
            safeQuery('dd.askingPrice .price-value')?.textContent?.trim() || null;
  }

  // ── Processing fee ────────────────────────────────────────
  let processingFee = null;
  if (selectors.processing_fee) {
    processingFee = safeQuery(selectors.processing_fee)?.textContent?.trim() || null;
  }
  if (!processingFee) {
    processingFee = safeQuery('dd.ABCRule .price-value')?.textContent?.trim() || null;
  }

  // ── Mileage ───────────────────────────────────────────────
  let mileage = null;
  if (selectors.mileage) {
    mileage = safeQuery(selectors.mileage)?.textContent?.trim() || null;
  }
  if (!mileage) {
    const mileageEls = safeQueryAll('.highlight-badge, [class*="mileage"], [class*="miles"]');
    mileage = mileageEls.find(el => /miles|mi\b/i.test(el.innerText))?.innerText?.trim() || null;
  }

  // ── Colors + body style ───────────────────────────────────
  let exteriorColor = null;
  let interiorColor = null;
  let bodyStyle = null;

  if (selectors.exterior_color) {
    exteriorColor = safeQuery(selectors.exterior_color)?.textContent?.trim() || null;
  }
  if (selectors.interior_color) {
    interiorColor = safeQuery(selectors.interior_color)?.textContent?.trim() || null;
  }
  if (selectors.body_style) {
    const raw = safeQuery(selectors.body_style)?.textContent?.trim() || null;
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

  // ── Photos ────────────────────────────────────────────────
  // Run all methods and keep whichever yields the most photos

  // Method 1: config selector
  let photosBySelector = [];
  if (selectors.photos) {
    photosBySelector = safeQueryAll(selectors.photos)
      .map(img => (img.getAttribute('data-src') || img.src || '').replace(/\?.*$/, ''))
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
      .map(img => (img.getAttribute('data-src') || img.src || '').replace(/\?.*$/, ''))
      .filter(src => src.startsWith('http') && src.match(/\.(jpg|jpeg|webp|png)/i))
      .filter(src => !skipPatterns.some(p => src.toLowerCase().includes(p)))
      .filter((src, i, arr) => arr.indexOf(src) === i)
      .slice(0, 40);
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

async function markListingPosted(vehicle, listingUrl) {
  const { token } = await chrome.storage.local.get("token");
  if (!token || !listingUrl) return;

  try {
    // Find the listing in backend by VIN
    const listingsResp = await fetch(`${API_BASE}/listings/`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (listingsResp.status === 401) { await handleExpiredToken(); return; }
    if (!listingsResp.ok) return;

    const listings = await listingsResp.json();
    const match = listings.find(l =>
      (vehicle?.vin && l.vin === vehicle.vin) ||
      (l.make === vehicle?.make && l.model === vehicle?.model && l.year === vehicle?.year)
    );

    if (match) {
      await fetch(`${API_BASE}/listings/${match.id}/posted`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}` },
      });
      console.log(`DealersOrbit: Marked listing ${match.id} as posted, URL: ${listingUrl}`);
    }
  } catch (err) {
    console.error("DealersOrbit: Failed to mark listing posted:", err);
  }
}

function parseTrimFromTitle(title, year, make, model) {
  if (!title) return null;
  let trim = title;
  if (year) trim = trim.replace(year, '');
  if (make) trim = trim.replace(new RegExp(make, 'gi'), '');
  if (model) trim = trim.replace(new RegExp(model, 'gi'), '');
  return trim.trim().replace(/\s+/g, ' ') || null;
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

  const job = {
    id: Date.now().toString(),
    vehicle: vehicle,
    video_type: videoType,
    outro_video_id: outroVideoId,
    status: photosOnly ? "completed" : "waiting",
    custom_script: customScript || null,
    theme: theme,
    language: language || 'en',
    added_at: new Date().toISOString(),
    progress: photosOnly ? 100 : 0,
    label: photosOnly ? "Photos ready — Post to FB" : "Waiting...",
    error: null,
    result_url: null,
  };

  queue.push(job);
  await chrome.storage.local.set({ queue });
  if (!photosOnly) processQueue();
  return queue.length;
}

async function processQueue() {
  const { queue = [] } = await chrome.storage.local.get("queue");

  // If a job is in generating state with an api_job_id, the service worker
  // may have restarted mid-poll — resume polling instead of starting a new job.
  const generatingJob = queue.find(j => j.status === "generating");
  if (generatingJob) {
    if (generatingJob.api_job_id) {
      console.log('DealersOrbit: Resuming poll for job', generatingJob.id);
      resumePolling(generatingJob, queue);
    }
    return;
  }

  const nextJob = queue.find(j => j.status === "waiting");
  if (!nextJob) return;

  nextJob.status = "generating";
  await saveQueue(queue);

  console.log(`DealersOrbit: Processing — ${nextJob.vehicle.year} ${nextJob.vehicle.make} ${nextJob.vehicle.model}`);

  try {
    await realProcessing(nextJob, queue);
    if (nextJob.status !== "completed") {
      nextJob.status = "completed";
      nextJob.progress = 100;
      nextJob.label = "Complete!";
    }
  } catch (err) {
    nextJob.status = "failed";
    nextJob.error = err.message;
  }

  await saveQueue(queue);
  processQueue();
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

  const POLL_INTERVAL = 8000;
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
          await saveQueue(queue);
          await saveToListingHistory(job, pollData, token);
          processQueue();
          return;
        }

        if (pollData.status === 'failed') {
          job.status = 'failed';
          job.error  = pollData.error_message || 'Pipeline failed';
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
  const POLL_INTERVAL = 8000;   // 8 seconds
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
      await saveQueue(queue);

      console.log("DealersOrbit: Job completed, attempting to save to history...");
      console.log("DealersOrbit: token available:", !!token);
      console.log("DealersOrbit: final_video_url:", pollData.final_video_url);

      await saveToListingHistory(jobSnapshot, pollData, token);
      return;
    }

    if (pollData.status === "failed") {
      job.status = "failed";
      job.error = pollData.error_message || "Pipeline failed.";
      await saveQueue(queue);
      throw new Error(pollData.error_message || "Pipeline failed.");
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