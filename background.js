/**
 * OrbitAds Background Service Worker
 * ─────────────────────────────────────
 * Handles:
 *   1. GET_CONFIG     — returns scraper config for a domain
 *   2. ADD_TO_QUEUE   — scrapes detail page then adds to queue
 *   3. Queue processing — sends jobs to OrbitAds backend one at a time
 */

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
  },
};

const API_BASE = "http://localhost:8000/api/v1";

function getConfigForDomain(domain) {
  console.log("OrbitAds: Looking up domain:", domain);

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

// ── Message handler ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "GET_CONFIG") {
    const config = getConfigForDomain(message.domain);
    console.log(`OrbitAds: Config for ${message.domain}:`, config?.name || "none");
    sendResponse({ config });
    return true;
  }

  if (message.type === "ADD_TO_QUEUE") {
    console.log("OrbitAds: Received vehicle, fetching detail page...", message.vehicle);
    enrichAndQueue(message.vehicle)
      .then(result => sendResponse({ success: true, queueLength: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "QUEUE_REVIEWED") {
    addToQueue(message.vehicle, message.video_type || "walkaround")
      .then(result => sendResponse({ success: true, queueLength: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
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

// ── Detail page enrichment ────────────────────────────────────
async function enrichAndQueue(vehicle) {

  const domain = vehicle.listing_url
    ? new URL(vehicle.listing_url).hostname
    : null;

  if (!vehicle.listing_url) {
    return addToQueue(vehicle);
  }

  let tab = null;
  try {
    console.log(`OrbitAds: Opening detail page: ${vehicle.listing_url}`);

    tab = await chrome.tabs.create({
      url: vehicle.listing_url,
      active: false,
    });

    await waitForTabLoad(tab.id);
    await sleep(4000);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractDetailPageData,
    });

    const detailData = results?.[0]?.result;
    console.log("OrbitAds: Detail page data:", detailData);

    if (detailData) {
      vehicle.vin = detailData.vin || vehicle.vin;
      vehicle.price = detailData.price || vehicle.price;
      vehicle.mileage = detailData.mileage || vehicle.mileage;

      if (detailData.photos && detailData.photos.length > vehicle.photos.length) {
        vehicle.photos = detailData.photos;
        console.log(`OrbitAds: Got ${detailData.photos.length} full photos`);
      }

      // Apply photo hints to pre-select the right photos for classification
      const domainConfig = getConfigForDomain(domain);
      const photoHints = domainConfig?.photo_hints;
      vehicle.photos_for_video = applyPhotoHints(vehicle.photos, photoHints);
      console.log(`OrbitAds: Selected ${vehicle.photos_for_video.length} photos for classification using hints: ${JSON.stringify(photoHints)}`);

      if (!vehicle.trim && detailData.title) {
        vehicle.trim = parseTrimFromTitle(
          detailData.title, vehicle.year, vehicle.make, vehicle.model
        );
      }
    }

  } catch (err) {
    console.error("OrbitAds: Detail page scrape failed:", err);
  } finally {
    if (tab) {
      try { await chrome.tabs.remove(tab.id); } catch (e) { }
    }
  }

  // Store for review instead of queuing directly
  await chrome.storage.local.set({
    pending_review: {
      vehicle: vehicle,
      photos_all: vehicle.photos,              // ALL photos for the UI
      photos_for_video: vehicle.photos_for_video || vehicle.photos.slice(0, 20),
      classified: null,
      added_at: new Date().toISOString(),
    }
  });

  // Open the popup so user sees the review screen
  chrome.action.openPopup().catch(() => {
    // openPopup() only works if called from a user gesture in some Chrome versions
    // If it fails, the badge will alert the user
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#1a56db" });
  });

  // Classify photos in the background while popup is opening
  classifyInBackground(vehicle);

  return 1;
}

async function classifyInBackground(vehicle) {
  // Classify up to 30 photos — enough to catch logos mixed in with real photos
  const hintPhotos = vehicle.photos_for_video || [];
  const allPhotos = vehicle.photos || [];

  // Combine hint-selected photos with first few from full list
  // to catch logos that appear early in the sequence
  const photosToClassify = [...new Set([
    ...allPhotos.slice(0, 5),    // first 5 (often includes logo at JBA)
    ...hintPhotos,               // hint-selected exterior/interior candidates
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

    if (!resp.ok) return;

    const classified = await resp.json();

    // First photo of listing is almost always exterior — rescue it
    const firstPhoto = vehicle.photos[0];
    const alreadyInExterior = classified.exterior?.includes(firstPhoto);

    if (firstPhoto && !alreadyInExterior) {
      // Remove from wherever it ended up
      classified.other = (classified.other || []).filter(u => u !== firstPhoto);
      classified.interior = (classified.interior || []).filter(u => u !== firstPhoto);
      classified.additional = (classified.additional || []).filter(u => u !== firstPhoto);
      // Force into exterior first position
      classified.exterior = [firstPhoto, ...(classified.exterior || [])];
      console.log("OrbitAds: Rescued first photo to exterior");
    }


    // Store Claude's explicit "other" classifications separately
    // These should NEVER be auto-filled into additional
    const explicitOther = new Set(classified.other || []);

    const { pending_review } = await chrome.storage.local.get("pending_review");
    if (pending_review) {
      pending_review.classified = classified;
      pending_review.explicit_other = Array.from(explicitOther);
      await chrome.storage.local.set({ pending_review });
    }

  } catch (err) {
    console.error("OrbitAds: Background classification failed:", err);
  }
}

/**
 * This function is injected into the detail page tab.
 * It runs in the context of the dealership website.
 * Must be self-contained — no references to variables outside this function.
 */
function extractDetailPageData() {
  // ── Trigger full carousel load ────────────────────────────
  // Click through all carousel slides to force lazy loading
  const nextBtns = document.querySelectorAll(
    '.slick-next, [aria-label="Next Photo"], [title="Next Photo"], ' +
    '.carousel-next, .gallery-next, button[class*="next"]'
  );

  const totalSlides = document.querySelectorAll(
    '.slick-slide:not(.slick-cloned)'
  ).length || 0;

  // Click next button enough times to cycle through all slides
  if (nextBtns.length > 0) {
    for (let i = 0; i < totalSlides + 2; i++) {
      nextBtns[0].click();
    }
  }

  // Also trigger lazy load on all images with data-src
  document.querySelectorAll('img[data-src], img[data-lazy-src], img[data-lazysrc]').forEach(img => {
    if (img.dataset.src) img.src = img.dataset.src;
    if (img.dataset.lazySrc) img.src = img.dataset.lazySrc;
    if (img.dataset.lazysrc) img.src = img.dataset.lazysrc;
  });

  // ── VIN ───────────────────────────────────────────────────
  const vinEl = document.querySelector('[data-vin]') ||
    document.querySelector('.vin-value') ||
    document.querySelector('[class*="vin"]');
  const vinText = vinEl?.getAttribute('data-vin') ||
    vinEl?.innerText?.match(/[A-HJ-NPR-Z0-9]{17}/i)?.[0];
  const bodyVin = document.body.innerText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/)?.[1];
  const vin = vinText || bodyVin || null;

  // ── Title ─────────────────────────────────────────────────
  const titleEl = document.querySelector('h1, .vehicle-title, [class*="vehicle-name"]');
  const titleText = titleEl?.innerText?.trim() || '';

  // ── Full photo gallery ────────────────────────────────────
  // Extract ALL photo URLs directly from page HTML source
  // This gets all photos regardless of carousel state or lazy loading
  const html = document.documentElement.innerHTML;

  // Find all pictures.dealer.com URLs in the raw HTML
  const allMatches = html.match(/https:\/\/pictures\.dealer\.com\/[^"'\s>\\]+/g) || [];

  const photoSources = new Set();
  allMatches.forEach(url => {
    // Clean the URL — strip query params and escape sequences
    const clean = url
      .replace(/\\u0026.*/, '')  // remove escaped ampersands and everything after
      .replace(/\?.*/, '')        // remove query params
      .replace(/\\.*/, '');       // remove any remaining escape sequences
    if (clean && clean.match(/\.(jpg|jpeg|png|webp)$/i)) {
      photoSources.add(clean);
    }
  });

  // Filter out thumbnails and junk
  const skipPatterns = [
    'thumb_', '/thumb/', 'thumbnail', 'logo', 'icon',
    'badge', 'placeholder', '1x1', 'spacer'
  ];
  const photos = Array.from(photoSources)
    .filter(src => !skipPatterns.some(p => src.toLowerCase().includes(p)))
    .slice(0, 40);

  // ── Price ─────────────────────────────────────────────────
  // ── Price ─────────────────────────────────────────────────
  // Get the actual dollar amount, not the label
  const priceEl = document.querySelector(
    '.final-price.internetPrice.font-weight-bo, ' +
    '.final-price.internetPrice:not(.price-label)'
  );
  // Filter out label text — we want the element with a $ sign
  let price = null;
  if (priceEl) {
    const text = priceEl.innerText?.trim();
    price = text?.includes('$') ? text : null;
  }
  // Fallback — find any element with $ and "price" class
  if (!price) {
    const allPriceEls = Array.from(document.querySelectorAll('[class*="price"]'));
    const dollarEl = allPriceEls.find(el =>
      el.innerText?.trim().startsWith('$') &&
      !el.querySelector('*')  // leaf node only
    );
    price = dollarEl?.innerText?.trim() || null;
  }

  // ── Mileage ───────────────────────────────────────────────
  const mileageEls = Array.from(
    document.querySelectorAll('.highlight-badge, [class*="mileage"], [class*="miles"]')
  );
  const mileage = mileageEls
    .find(el => /miles|mi\b/i.test(el.innerText))?.innerText?.trim() || null;

  return { vin, title: titleText, photos, price, mileage };
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


function parseTrimFromTitle(title, year, make, model) {
  if (!title) return null;
  let trim = title;
  if (year) trim = trim.replace(year, '');
  if (make) trim = trim.replace(new RegExp(make, 'gi'), '');
  if (model) trim = trim.replace(new RegExp(model, 'gi'), '');
  return trim.trim().replace(/\s+/g, ' ') || null;
}


// ── Queue management ──────────────────────────────────────────
async function addToQueue(vehicle, videoType = "walkaround") {
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
      console.log(`OrbitAds: VIN ${vehicle.vin} already in queue, skipping.`);
      return queue.length;
    }
  }

  const job = {
    id:         Date.now().toString(),
    vehicle:    vehicle,
    theme:      defaultTheme,
    video_type: videoType,        // ← store video type
    status:     "waiting",
    added_at:   new Date().toISOString(),
    progress:   0,
    label:      "Waiting...",
    error:      null,
    result_url: null,
  };

  queue.push(job);
  await chrome.storage.local.set({ queue });
  processQueue();
  return queue.length;
}

async function processQueue() {
  const { queue = [], processing = false } = await chrome.storage.local.get(["queue", "processing"]);
  if (processing) return;

  const nextJob = queue.find(j => j.status === "waiting");
  if (!nextJob) return;

  await chrome.storage.local.set({ processing: true });
  nextJob.status = "generating";
  await saveQueue(queue);

  console.log(`OrbitAds: Processing — ${nextJob.vehicle.year} ${nextJob.vehicle.make} ${nextJob.vehicle.model}`);

  try {
    await realProcessing(nextJob, queue);
    // Explicitly mark as completed if realProcessing didn't
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
  await chrome.storage.local.set({ processing: false });
  processQueue();
}


async function realProcessing(job, queue) {
  const { token } = await chrome.storage.local.get("token");

  if (!token) {
    throw new Error("Not logged in — please sign in via the extension popup.");
  }

  const v = job.vehicle;

  // ── Submit the job to OrbitAds backend ──────────────────
  const jobPayload = {
    vin: v.vin || null,
    listing_url: v.listing_url || null,
    theme: job.theme || "family",
    video_type: job.video_type || "walkaround",   // ← add this
    car_photo_urls: v.photos_for_video?.length
      ? JSON.stringify(v.photos_for_video)
      : null,
  };

  const createResp = await fetch(`${API_BASE}/jobs/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(jobPayload),
  });

  if (!createResp.ok) {
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

    if (!pollResp.ok) continue;

    const pollData = await pollResp.json();

    const statusMap = {
      "pending":           { progress: 5,   label: "Starting pipeline..." },
      "vin_decoding":      { progress: 15,  label: "Decoding VIN..." },
      "script_generating": { progress: 35,  label: "Writing ad script..." },
      "voice_cloning":     { progress: 55,  label: "Cloning voice..." },
      "avatar_generating": { progress: 75,  label: "Generating avatar..." },
      "assembling":        { progress: 88,  label: "Assembling video..." },
      "completed":         { progress: 100, label: "Complete!" },
      "failed":            { progress: 0,   label: pollData.error_message || "Failed" },
    };

    const mapped = statusMap[pollData.status] || { progress: job.progress, label: job.label };
    job.progress = mapped.progress;
    job.label    = mapped.label;
    await saveQueue(queue);

    if (pollData.status === "completed") {
      job.result_url = pollData.final_video_url;
      job.status     = "completed";
      job.progress   = 100;
      job.label      = "Complete!";
      await saveQueue(queue);  // save again with result_url
      return;
    }

    if (pollData.status === "failed") {
      job.status = "failed";
      job.error  = pollData.error_message || "Pipeline failed.";
      await saveQueue(queue);
      throw new Error(pollData.error_message || "Pipeline failed.");
    }
  }
}


async function saveQueue(queue) {
  await chrome.storage.local.set({ queue });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}