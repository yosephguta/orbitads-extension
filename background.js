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
    inventory_page: {
      url_patterns: ["/inventory", "/new-inventory", "/used-inventory",
                     "/certified-inventory", "/pre-owned"],
      card_selector: "li.vehicle-card",
      extractors: {
        vin:     { type: "attribute", selector: "li.vehicle-card", attribute: "data-vin" },
        uuid:    { type: "attribute", selector: "li.vehicle-card", attribute: "data-uuid" },
        title:   { type: "text",  selector: "h2, h3, [class*='vehicle-title']" },
        price:   { type: "text",  selector: ".final-price.internetPrice.font-weight-bo, .final-price.internetPrice" },
        mileage: { type: "text",  selector: ".highlight-badge", filter: "miles" },
        link:    { type: "href",  selector: "a" },
        photos:  { type: "images", selector: "img", strip_params: true },
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
  "jbakia.com":     { dealership_name: "JBA Kia", provider: "dealer_inspire", overrides: {} },
  "www.jbakia.com": { dealership_name: "JBA Kia", provider: "dealer_inspire", overrides: {} },
};

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
    provider:        dealerConfig.provider,
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
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return true;
});


// ── Detail page enrichment ────────────────────────────────────
async function enrichAndQueue(vehicle) {
  if (!vehicle.listing_url) {
    return addToQueue(vehicle);
  }

  let tab = null;
  try {
    console.log(`OrbitAds: Opening detail page: ${vehicle.listing_url}`);

    tab = await chrome.tabs.create({
      url:    vehicle.listing_url,
      active: false,
    });

    await waitForTabLoad(tab.id);
    await sleep(4000);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   extractDetailPageData,
    });

    const detailData = results?.[0]?.result;
    console.log("OrbitAds: Detail page data:", detailData);

    if (detailData) {
      vehicle.vin     = detailData.vin     || vehicle.vin;
      vehicle.price   = detailData.price   || vehicle.price;
      vehicle.mileage = detailData.mileage || vehicle.mileage;

      if (detailData.photos && detailData.photos.length > vehicle.photos.length) {
        vehicle.photos = detailData.photos;
        console.log(`OrbitAds: Got ${detailData.photos.length} full photos`);
      }

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
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
  }

  return addToQueue(vehicle);
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
    if (img.dataset.src)     img.src = img.dataset.src;
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
  if (year)  trim = trim.replace(year, '');
  if (make)  trim = trim.replace(new RegExp(make, 'gi'), '');
  if (model) trim = trim.replace(new RegExp(model, 'gi'), '');
  return trim.trim().replace(/\s+/g, ' ') || null;
}


// ── Queue management ──────────────────────────────────────────
async function addToQueue(vehicle) {
  const { queue = [] } = await chrome.storage.local.get("queue");

  const job = {
    id:         Date.now().toString(),
    vehicle:    vehicle,
    status:     "waiting",
    added_at:   new Date().toISOString(),
    progress:   0,
    label:      "Waiting...",
    error:      null,
    result_url: null,
  };

  queue.push(job);
  await chrome.storage.local.set({ queue });
  console.log(`OrbitAds: Queued (${vehicle.photos?.length || 0} photos). Queue: ${queue.length}`);

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
    await simulateProcessing(nextJob, queue);
  } catch (err) {
    nextJob.status = "failed";
    nextJob.error  = err.message;
  }

  await saveQueue(queue);
  await chrome.storage.local.set({ processing: false });
  processQueue();
}


async function simulateProcessing(job, queue) {
  const stages = [
    { progress: 10, label: "Decoding VIN...",       delay: 500  },
    { progress: 30, label: "Generating script...",  delay: 1000 },
    { progress: 55, label: "Cloning voice...",      delay: 800  },
    { progress: 75, label: "Generating avatar...",  delay: 1000 },
    { progress: 90, label: "Assembling video...",   delay: 800  },
  ];

  for (const stage of stages) {
    job.progress = stage.progress;
    job.label    = stage.label;
    await saveQueue(queue);
    await sleep(stage.delay);
  }

  job.status     = "completed";
  job.progress   = 100;
  job.label      = "Complete!";
  job.result_url = "https://example.com/placeholder-video.mp4";
}


async function saveQueue(queue) {
  await chrome.storage.local.set({ queue });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}