/**
 * OrbitAds Background Service Worker
 * ─────────────────────────────────────
 * Handles:
 *   1. GET_CONFIG     — returns scraper config for a domain
 *   2. ADD_TO_QUEUE   — scrapes detail page then adds to queue
 *   3. Queue processing — sends jobs to OrbitAds backend one at a time
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

  if (message.type === "CLASSIFY_PENDING") {
    classifyInBackground(message.vehicle);
    sendResponse({ success: true });
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

// ── Global processing lock ─────────────────────────────────
let isEnriching = false;
const enrichQueue = [];

async function enrichAndQueue(vehicle) {
  // Add to processing queue
  enrichQueue.push(vehicle);

  // If already processing, let the running instance handle it
  if (isEnriching) {
    console.log(`OrbitAds: Queued for enrichment: ${vehicle.model}. Queue: ${enrichQueue.length}`);
    return;
  }

  // Process queue sequentially
  isEnriching = true;
  while (enrichQueue.length > 0) {
    const next = enrichQueue.shift();
    await enrichSingleVehicle(next);
  }
  isEnriching = false;
}

async function enrichSingleVehicle(vehicle) {
  console.log("OrbitAds: enrichSingleVehicle:", vehicle.model);
  console.log("OrbitAds: listing_url:", vehicle.listing_url);

  // ── Step 1: Scrape detail page ───────────────────────────
  if (vehicle.listing_url) {
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
      console.log(`OrbitAds: Detail page data for ${vehicle.model}:`, detailData);

      if (detailData) {
        // Verify data matches expected vehicle before using it
        const titleMatch = !detailData.title ||
          detailData.title.toLowerCase().includes(vehicle.model?.toLowerCase().split(' ')[0]) ||
          detailData.title.toLowerCase().includes(vehicle.make?.toLowerCase()) ||
          detailData.title.toLowerCase().includes(vehicle.year);

        if (!titleMatch) {
          console.warn(`OrbitAds: Title mismatch! Expected ${vehicle.model}, got ${detailData.title}. Skipping detail data.`);
        } else {
          vehicle.vin = detailData.vin || vehicle.vin;
          vehicle.price = detailData.price || vehicle.price;
          vehicle.mileage = detailData.mileage || vehicle.mileage;

          if (detailData.photos?.length > (vehicle.photos?.length || 0)) {
            vehicle.photos = detailData.photos;
            console.log(`OrbitAds: Got ${detailData.photos.length} full photos`);
          }

          if (!vehicle.trim && detailData.title) {
            vehicle.trim = parseTrimFromTitle(
              detailData.title, vehicle.year, vehicle.make, vehicle.model
            );
          }
        }
      }

      // Apply photo hints
      const domain = new URL(vehicle.listing_url).hostname;
      const domainConfig = getConfigForDomain(domain);
      vehicle.photos_for_video = applyPhotoHints(
        vehicle.photos || [], domainConfig?.photo_hints
      );
      console.log(`OrbitAds: Selected ${vehicle.photos_for_video.length} photos using hints`);

    } catch (err) {
      console.error("OrbitAds: Detail page scrape failed:", err);
    } finally {
      if (tab) {
        try { await chrome.tabs.remove(tab.id); } catch (e) { }
      }
    }
  }

  // ── Step 2: Always add to review queue as a card ──────────
  const { pending_review_queue = [] } =
    await chrome.storage.local.get("pending_review_queue");

  const reviewItem = {
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
    console.log(`OrbitAds: Skipping duplicate VIN: ${vehicle.vin}`);
    return;
  }

  pending_review_queue.push(reviewItem);
  await chrome.storage.local.set({
    pending_review_queue,
    pending_review: null,  // clear any stuck pending review
  });

  const total = pending_review_queue.length;
  chrome.action.setBadgeText({ text: String(total) });
  chrome.action.setBadgeBackgroundColor({ color: "#1a56db" });
  console.log(`OrbitAds: Added ${vehicle.model} to queue. Total: ${total}`);

  // Open side panel
  chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id })
    .catch(() => { });
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
    const explicitOther = new Set(classified.other || []);

    // Save to matching queue item first
    const { pending_review_queue = [] } =
      await chrome.storage.local.get("pending_review_queue");

    const idx = pending_review_queue.findIndex(item =>
      (vehicle.vin && item.vehicle?.vin === vehicle.vin) ||
      item.vehicle?.model === vehicle.model
    );

    if (idx >= 0) {
      pending_review_queue[idx].classified = classified;
      pending_review_queue[idx].explicit_other = Array.from(explicitOther);
      await chrome.storage.local.set({ pending_review_queue });
      console.log(`OrbitAds: Classification saved to queue item for ${vehicle.model}`);
    } else {
      // Fallback — save to pending_review
      const { pending_review } = await chrome.storage.local.get("pending_review");
      if (pending_review) {
        pending_review.classified = classified;
        pending_review.explicit_other = Array.from(explicitOther);
        await chrome.storage.local.set({ pending_review });
      }
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
    id: Date.now().toString(),
    vehicle: vehicle,
    theme: defaultTheme,
    video_type: videoType,        // ← store video type
    status: "waiting",
    added_at: new Date().toISOString(),
    progress: 0,
    label: "Waiting...",
    error: null,
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
    console.log("OrbitAds: Saved listing to history");
  } catch (err) {
    console.error("OrbitAds: Failed to save listing history:", err);
  }
}

async function realProcessing(job, queue) {
  const { token } = await chrome.storage.local.get("token");
  console.log("OrbitAds: realProcessing started, token:", !!token);

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
      "pending": { progress: 5, label: "Starting pipeline..." },
      "vin_decoding": { progress: 15, label: "Decoding VIN..." },
      "script_generating": { progress: 35, label: "Writing ad script..." },
      "voice_cloning": { progress: 55, label: "Cloning voice..." },
      "avatar_generating": { progress: 75, label: "Generating avatar..." },
      "assembling": { progress: 88, label: "Assembling video..." },
      "completed": { progress: 100, label: "Complete!" },
      "failed": { progress: 0, label: pollData.error_message || "Failed" },
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

      console.log("OrbitAds: Job completed, attempting to save to history...");
      console.log("OrbitAds: token available:", !!token);
      console.log("OrbitAds: final_video_url:", pollData.final_video_url);

      await saveToListingHistory(job, pollData, token);
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

// ── Facebook posting queue ────────────────────────────────────
const FB_MIN_GAP_MS = 7 * 60 * 1000;   // 7 minutes minimum
const FB_MAX_GAP_MS = 12 * 60 * 1000;  // 12 minutes maximum
const FB_MAX_PER_DAY = 10;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ... existing handlers ...

  if (message.type === "ADD_TO_FB_QUEUE") {
    addToFbQueue(message.listing, message.vehicle)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "FB_POSTED_CONFIRM") {
    confirmFbPosted(message.listing_id)
      .then(() => sendResponse({ success: true }));
    return true;
  }
});

async function addToFbQueue(listing, vehicle) {
  const { fb_post_queue = [], fb_posting_history = [] } =
    await chrome.storage.local.get(["fb_post_queue", "fb_posting_history"]);

  // Check daily limit
  const today = new Date().toDateString();
  const todayPosts = fb_posting_history.filter(
    p => new Date(p.timestamp).toDateString() === today
  ).length;

  if (todayPosts >= FB_MAX_PER_DAY) {
    console.log("OrbitAds: Daily Facebook posting limit reached");
    return;
  }

  const item = {
    id: Date.now().toString(),
    listing: listing,
    vehicle: vehicle,
    status: "waiting",
    added_at: new Date().toISOString(),
    post_after: calculateNextPostTime(fb_post_queue, fb_posting_history),
  };

  fb_post_queue.push(item);
  await chrome.storage.local.set({ fb_post_queue });

  console.log(`OrbitAds FB Queue: Added ${vehicle.year} ${vehicle.make} ${vehicle.model}. Post after: ${new Date(item.post_after).toLocaleTimeString()}`);

  // Open Facebook now if this is the first item and it's ready
  processFbQueue();
}

function calculateNextPostTime(queue, history) {
  const now = Date.now();

  // Find last post time from either queue or history
  const lastFromQueue = queue.filter(j => j.status === "posted")
    .map(j => new Date(j.posted_at).getTime())
    .sort((a, b) => b - a)[0];

  const lastFromHistory = history
    .map(h => new Date(h.timestamp).getTime())
    .sort((a, b) => b - a)[0];

  const lastPost = Math.max(lastFromQueue || 0, lastFromHistory || 0);

  if (!lastPost || now - lastPost > FB_MAX_GAP_MS) {
    // No recent posts — can post now (with small delay)
    return now + 3000;
  }

  // Calculate random gap between 7-12 minutes from last post
  const gap = FB_MIN_GAP_MS + Math.random() * (FB_MAX_GAP_MS - FB_MIN_GAP_MS);
  const postTime = lastPost + gap;

  return Math.max(postTime, now + 3000);
}

async function processFbQueue() {
  const { fb_post_queue = [] } = await chrome.storage.local.get("fb_post_queue");
  const now = Date.now();

  // Find next item ready to post
  const nextItem = fb_post_queue.find(
    j => j.status === "waiting" && new Date(j.post_after).getTime() <= now
  );

  if (!nextItem) {
    // Schedule check for when next item is ready
    const nextReady = fb_post_queue
      .filter(j => j.status === "waiting")
      .map(j => new Date(j.post_after).getTime())
      .sort((a, b) => a - b)[0];

    if (nextReady) {
      const delay = nextReady - now + 1000;
      console.log(`OrbitAds FB: Next post in ${Math.round(delay / 60000)} minutes`);
      setTimeout(processFbQueue, delay);
    }
    return;
  }

  // Mark as posting
  nextItem.status = "posting";
  await chrome.storage.local.set({ fb_post_queue });

  // Store the listing data for the content script
  await chrome.storage.local.set({
    fb_listing: {
      ...nextItem.listing,
      vehicle: nextItem.vehicle,
      reviewed_photos: nextItem.listing.reviewed_photos || [],
      queue_item_id: nextItem.id,
      created_at: new Date().toISOString(),
    }
  });

  // Open Facebook Marketplace create vehicle page
  chrome.tabs.create({
    url: "https://www.facebook.com/marketplace/create/vehicle",
  });

  console.log(`OrbitAds FB: Opening Facebook for ${nextItem.vehicle.year} ${nextItem.vehicle.make} ${nextItem.vehicle.model}`);
}

async function confirmFbPosted(queueItemId) {
  const { fb_post_queue = [], fb_posting_history = [] } =
    await chrome.storage.local.get(["fb_post_queue", "fb_posting_history"]);

  const item = fb_post_queue.find(j => j.id === queueItemId);
  if (item) {
    item.status = "posted";
    item.posted_at = new Date().toISOString();
  }

  // Add to history for rate limiting
  fb_posting_history.push({
    timestamp: new Date().toISOString(),
    vin: item?.vehicle?.vin,
  });

  // Keep only last 30 days of history
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const cleanHistory = fb_posting_history.filter(
    h => new Date(h.timestamp).getTime() > cutoff
  );

  await chrome.storage.local.set({
    fb_post_queue: fb_post_queue,
    fb_posting_history: cleanHistory,
  });

  // Process next item in queue
  setTimeout(processFbQueue, 1000);
}

// ── Daily sold vehicle checker ────────────────────────────────
async function runDailySoldCheck() {
  const { token, last_sold_check } = await chrome.storage.local.get([
    "token", "last_sold_check"
  ]);

  if (!token) return;

  // Only run once per day
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (last_sold_check && now - last_sold_check < oneDayMs) return;

  try {
    // Get user's listings from backend
    const listingsResp = await fetch(`${API_BASE}/listings/`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!listingsResp.ok) return;

    const listings = await listingsResp.json();
    const activeIds = listings
      .filter(l => !l.is_sold && l.listing_url)
      .map(l => l.id);

    if (activeIds.length === 0) return;

    // Check sold status
    const checkResp = await fetch(`${API_BASE}/listings/check-sold`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ listing_ids: activeIds }),
    });

    if (!checkResp.ok) return;

    const { sold_ids } = await checkResp.json();

    if (sold_ids.length > 0) {
      // Store sold notifications for popup to display
      await chrome.storage.local.set({
        sold_notifications: sold_ids,
      });

      // Show badge on extension icon
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });

      console.log(`OrbitAds: ${sold_ids.length} vehicles may be sold`);
    }

    await chrome.storage.local.set({ last_sold_check: now });

  } catch (err) {
    console.error("OrbitAds: Sold check failed:", err);
  }
}

// Run sold check on extension startup and every 6 hours
runDailySoldCheck();
setInterval(runDailySoldCheck, 6 * 60 * 60 * 1000);

async function saveQueue(queue) {
  await chrome.storage.local.set({ queue });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}