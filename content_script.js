
/**
 * DealersOrbit Content Script
 * ────────────────────────
 * Injected into vehicle listing pages by Chrome.
 * 
 * Responsibilities:
 *   1. Detect if this is a vehicle listing page
 *   2. Find car cards on inventory pages
 *   3. Inject "Import to DealersOrbit" buttons
 *   4. Scrape vehicle data when button is clicked
 *   5. Send data to background.js for queue processing
 */

// ── Constants ─────────────────────────────────────────────────
const BUTTON_CLASS = "dealersorbit-import-btn";
const INJECTED_ATTR = "data-dealersorbit-injected";
const BRAND_COLOR = "#1a56db";
const BRAND_COLOR_HOV = "#1e40af";

// VIN pattern — 17 alphanumeric characters (no I, O, Q)
const VIN_REGEX = /\b([A-HJ-NPR-Z0-9]{17})\b/;

// Price pattern — e.g. $19,995 or $19995
const PRICE_REGEX = /\$[\d,]+/;

// Year pattern — 4 digits starting with 19 or 20
const YEAR_REGEX = /\b(19|20)\d{2}\b/;

// Common car makes for detection
const CAR_MAKES = [
  "acura", "alfa", "audi", "bmw", "buick", "cadillac", "chevrolet", "chevy",
  "chrysler", "dodge", "ferrari", "fiat", "ford", "genesis", "gmc", "honda",
  "hyundai", "infiniti", "jaguar", "jeep", "kia", "lamborghini", "land rover",
  "lexus", "lincoln", "maserati", "mazda", "mercedes", "mini", "mitsubishi",
  "nissan", "porsche", "ram", "rivian", "rolls", "subaru", "tesla", "toyota",
  "volkswagen", "volvo", "vw",
];

// Get config for current domain from background script
async function getDealershipConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_CONFIG", domain: window.location.hostname },
      (response) => resolve(response?.config || null)
    );
  });
}

// ── Page detection ────────────────────────────────────────────
/**
 * Score this page to determine if it's a vehicle listing page.
 * Returns true if we're confident this is a vehicle page.
 */
function isVehiclePage() {
  const text = document.body.innerText.toLowerCase();
  let score = 0;

  // URL signals
  const url = window.location.href.toLowerCase();
  const urlSignals = [
    "inventory", "vehicle", "listing", "used", "new-cars", "certified",
    "for-sale", "pre-owned", "stock",
  ];
  if (urlSignals.some(s => url.includes(s))) score += 3;

  // DOM signals — price elements
  const priceEls = document.querySelectorAll(
    '[class*="price"],[id*="price"],[data-price]'
  );
  if (priceEls.length > 0) score += 2;

  // DOM signals — VIN anywhere on page
  if (VIN_REGEX.test(document.body.innerText)) score += 3;

  // DOM signals — year/make pattern in text
  if (YEAR_REGEX.test(text)) score += 1;
  if (CAR_MAKES.some(make => text.includes(make))) score += 2;

  // DOM signals — common listing page classes
  const listingSignals = [
    '[class*="vehicle"]', '[class*="listing"]', '[class*="inventory"]',
    '[class*="car-card"]', '[class*="vehicle-card"]', '[class*="result-item"]',
  ];
  const hasListingElements = listingSignals.some(
    sel => document.querySelector(sel) !== null
  );
  if (hasListingElements) score += 3;

  return score >= 4;
}


/**
 * Determine if this is an inventory page (multiple cars)
 * or a single vehicle detail page.
 */
function getPageType() {
  const url = window.location.href.toLowerCase();

  // Single listing signals in URL
  const singleSignals = [
    /\/vin\//, /\/vehicle\//, /\/listing\//,
    /[a-hj-npr-z0-9]{17}/i,   // VIN in URL
    /\/detail\//, /\/vdp\//,
  ];
  if (singleSignals.some(r => r.test(url))) return "single";

  // If we find many similar repeated card-like elements → inventory
  const candidateCards = findCarCards();
  if (candidateCards.length >= 2) return "inventory";

  // Single car detail page
  return "single";
}


// ── Car card detection ────────────────────────────────────────
/**
 * Find car cards on an inventory page.
 * Uses a scoring approach since every site has different HTML.
 * Returns array of DOM elements, each representing one car.
 */
function findCarCards() {
  // Candidate selectors — common patterns across dealership sites
  const candidateSelectors = [
    // Cars.com search results — fuse-card web components with JSON data
    'fuse-card[data-listing-id]',
    // Cars.com dealer inventory pages — shop_card divs
    'div[data-qa="shop_card"]',
    // CarGurus inventory tiles
    'div[data-testid="srp-listing-tile"]',
    // Generic card patterns
    '[class*="vehicle-card"]',
    '[class*="car-card"]',
    '[class*="inventory-item"]',
    '[class*="listing-item"]',
    '[class*="result-item"]',
    '[class*="vehicle-item"]',
    '[class*="search-result"]',
    // CarGurus
    '[data-cg-ft="srp-listing-blade"]',
    // AutoTrader
    '[data-qaid="cntnr-lstng-tile"]',
    // Generic
    '.inventory-listing',
    '.vehicle-listing',
    '.car-listing',
  ];

  let bestCards = [];

  for (const selector of candidateSelectors) {
    try {
      const els = Array.from(document.querySelectorAll(selector));
      if (els.length >= 2) {
        // Score each element — does it look like a car card?
        const scored = els.filter(el => scoreCardElement(el) >= 2);
        if (scored.length > bestCards.length) {
          bestCards = scored;
        }
      }
    } catch (e) {
      // Invalid selector — skip
    }
  }

  // Fallback: find repeated elements with car-like content
  if (bestCards.length === 0) {
    bestCards = findRepeatedCarElements();
  }

  return bestCards;
}


/**
 * Score a DOM element — how likely is it to be a car card?
 */
function scoreCardElement(el) {
  const text = el.innerText || "";
  const html = el.innerHTML || "";
  let score = 0;

  if (PRICE_REGEX.test(text)) score += 2;
  if (YEAR_REGEX.test(text)) score += 1;
  if (VIN_REGEX.test(text)) score += 2;
  if (CAR_MAKES.some(m => text.toLowerCase().includes(m))) score += 1;
  if (el.querySelector("img")) score += 1;  // has an image

  // Penalize if too small (likely a nav item or footer link)
  const rect = el.getBoundingClientRect();
  if (rect.width < 100 || rect.height < 100) score -= 3;

  return score;
}


/**
 * Fallback: find repeated similar elements that look like car cards.
 * Looks for elements with the same tag/class that appear 3+ times.
 */
function findRepeatedCarElements() {
  const counts = {};
  const allEls = document.querySelectorAll("article, li, div[class]");

  allEls.forEach(el => {
    const key = el.tagName + "." + (el.className || "").split(" ")[0];
    if (!counts[key]) counts[key] = [];
    counts[key].push(el);
  });

  // Find groups of 3+ repeated elements that score as car cards
  for (const [key, els] of Object.entries(counts)) {
    if (els.length >= 3) {
      const scored = els.filter(el => scoreCardElement(el) >= 2);
      if (scored.length >= 3) return scored;
    }
  }

  return [];
}


// ── Data scraping ─────────────────────────────────────────────
/**
 * Scrape vehicle data from a car card element (inventory page)
 * or from the full page (single listing page).
 */
/**
 * Cars.com dealer inventory page scraper — reads data-override-payload attribute.
 * Used on /dealers/{id}/{name}/inventory/ pages which use div[data-qa="shop_card"].
 */
function scrapeCarsDotComDealerCard(card) {
  try {
    const raw = card.getAttribute('data-override-payload');
    const data = raw ? JSON.parse(raw) : {};

    // Title from the heading element (already properly cased, e.g. "2025 Honda CR-V Hybrid Sport-L")
    const titleEl = card.querySelector('[data-qa="title"]');
    const titleText = titleEl?.textContent?.trim() || '';

    const year = data.model_year?.toString() || null;

    // Title-case the make (data has it lowercase: "honda" → "Honda")
    const makeLower = data.make || '';
    const make = makeLower.split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || null;

    // Model from title text (more accurate than the URL-slug in data)
    // "2025 Honda CR-V Hybrid Sport-L" → strip year + make → "CR-V Hybrid Sport-L"
    let model = null;
    if (titleText && year && make) {
      model = titleText
        .replace(year, '')
        .replace(new RegExp(make.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
        .trim() || null;
    }

    // Listing URL
    const linkEl = card.querySelector('a.shop-card-link, a[href*="/vehicledetail/"]');
    const href = linkEl?.getAttribute('href') || '';
    const listingUrl = href
      ? (href.startsWith('http') ? href : 'https://www.cars.com' + href)
      : window.location.href;

    // Price from DOM first, fall back to data attribute
    const priceEl = card.querySelector('[data-qa="primary-price"]');
    const priceMatch = priceEl?.textContent?.match(/\$[\d,]+/);
    const priceNum = parseInt(data.price || '0');
    const price = priceMatch ? priceMatch[0]
      : (priceNum > 0 ? '$' + priceNum.toLocaleString() : null);

    // Mileage
    let mileage = null;
    if ((data.stock_type || '').toLowerCase() === 'new') {
      mileage = 'New';
    } else {
      const mileageEl = card.querySelector('[data-qa="mileage"]');
      const mileageMatch = mileageEl?.textContent?.match(/([\d,]+)/);
      if (mileageMatch) mileage = mileageMatch[0] + ' mi';
    }

    // Single thumbnail photo, upgrade to xxlarge
    const imgEl = card.querySelector('img.vehicle-image, [data-qa="vehicle_image"] img');
    const imgSrc = (imgEl?.src || '').replace('/large/', '/xxlarge/').replace(/\?.*$/, '');
    const photos = imgSrc && imgSrc.startsWith('http') ? [imgSrc] : [];

    return {
      vin:         null,  // not on card, will be populated from VDP scrape
      year,
      make,
      model,
      trim:        null,
      title:       titleText || [year, make, model].filter(Boolean).join(' '),
      price,
      mileage,
      photos,
      listing_url: listingUrl,
      source_url:  window.location.href,
      scraped_at:  new Date().toISOString(),
    };
  } catch (e) {
    return null;
  }
}

/**
 * CarGurus inventory card scraper.
 * The hidden <dl> inside each card contains ALL vehicle data (VIN, colors, mileage, etc.)
 * in structured dt/dd pairs — no JSON attribute needed.
 */
function scrapeCarGurus(card) {
  try {
    // Parse the hidden dl — every field is a dt label + dd value
    const dl = card.querySelector('dl');
    const specs = {};
    if (dl) {
      Array.from(dl.querySelectorAll('dt')).forEach(dt => {
        const label = dt.textContent.replace(':', '').trim().toLowerCase();
        const dd = dt.nextElementSibling;
        if (dd) specs[label] = dd.textContent.trim();
      });
    }

    // Listing URL — full path to VDP
    const link = card.querySelector('a[data-testid="tile-link"]');
    const href = link?.getAttribute('href') || '';
    const listingUrl = href.startsWith('http') ? href : 'https://www.cargurus.com' + href;

    // Price from the visible price element
    const priceEl = card.querySelector('[data-testid="srp-tile-price"]');
    const priceMatch = priceEl?.textContent?.match(/\$[\d,]+/);
    const price = priceMatch ? priceMatch[0] : null;

    // Mileage — specs have it without " mi" suffix
    const mileageRaw = specs['mileage'];
    const mileage = mileageRaw ? mileageRaw.replace(/[^\d,]/g, '').trim()
      ? mileageRaw.replace(/[^\d,]/g, '').trim() + ' mi'
      : null : null;

    // Photo — strip query params from the listing thumbnail (already 1024×768)
    const imgEl = card.querySelector('img[data-testid="srp-listing-tile-image"]');
    const imgSrc = (imgEl?.src || imgEl?.getAttribute('src') || '').split('?')[0];
    const photos = imgSrc && imgSrc.startsWith('http') ? [imgSrc] : [];

    const year  = specs['year']  || null;
    const make  = specs['make']  || null;
    const model = specs['model'] || null;
    const vin   = specs['vin']   || null;

    // Trim from the visible subtitle (specs have a long trim+body+drivetrain string)
    const trimEl = card.querySelector('[data-cg-ft="vehicle"]');
    const trim = trimEl?.textContent?.trim() || null;

    return {
      vin,
      year,
      make,
      model,
      trim,
      title:          [year, make, model].filter(Boolean).join(' '),
      price,
      mileage,
      exterior_color: specs['exterior color'] || null,
      interior_color: specs['interior color'] || null,
      body_style:     specs['body type']      || null,
      photos,
      listing_url:    listingUrl,
      source_url:     window.location.href,
      scraped_at:     new Date().toISOString(),
    };
  } catch (e) {
    return null;
  }
}

function scrapeVehicleFromCard(card) {
  // Cars.com search results — fuse-card with data-vehicle-details JSON
  if (card.tagName.toLowerCase() === 'fuse-card') {
    const carsData = scrapeCarsDotCom(card);
    if (carsData) return carsData;
  }

  // Cars.com dealer inventory — div[data-qa="shop_card"] with data-override-payload
  if (card.getAttribute('data-qa') === 'shop_card') {
    const dealerData = scrapeCarsDotComDealerCard(card);
    if (dealerData) return dealerData;
  }

  // CarGurus inventory tile — div[data-testid="srp-listing-tile"]
  if (card.getAttribute('data-testid') === 'srp-listing-tile') {
    const cgData = scrapeCarGurus(card);
    if (cgData) return cgData;
  }

  // Generic scraper for all other sites
  const text = card.innerText || "";
  return {
    vin: extractVIN(text) || extractVIN(document.body.innerText),
    year: extractYear(text),
    make: extractMake(text),
    model: extractModel(card),
    trim: extractTrim(card),
    price: extractPrice(text),
    mileage: extractMileage(text),
    photos: extractPhotosFromCard(card),
    listing_url: extractListingUrl(card),
    source_url: window.location.href,
    scraped_at: new Date().toISOString(),
  };
}

/**
 * Cars.com specific scraper — reads JSON from data-vehicle-details attribute
 */
function scrapeCarsDotCom(card) {
  try {
    const raw = card.getAttribute('data-vehicle-details');
    if (!raw) return null;

    const data = JSON.parse(raw);

    // Listing URL from card-gallery data-card-href, then a[data-card-link], then listingId
    const galleryEl = card.querySelector('card-gallery');
    const cardHref = galleryEl?.getAttribute('data-card-href') ||
                     card.querySelector('a[data-card-link]')?.getAttribute('href') ||
                     (data.listingId ? `/vehicledetail/${data.listingId}/` : null);
    const listingUrl = cardHref
      ? (cardHref.startsWith('http') ? cardHref : 'https://www.cars.com' + cardHref)
      : window.location.href;

    // Dealer name — first .fuse-body-small with text-weaker CSS variable
    const dealerNameEl = Array.from(card.querySelectorAll('.fuse-body-small'))
      .find(el => (el.getAttribute('style') || '').includes('text-weaker'));
    const dealerName = dealerNameEl?.textContent?.trim() || null;

    // Price — data.price is a raw number string e.g. "56233"; parseInt formats correctly
    const priceNum = parseInt(data.price || '0');
    const price = priceNum > 0 ? '$' + priceNum.toLocaleString() : null;

    // Mileage — new cars have stockType "New"
    let mileage = null;
    if (data.stockType === 'New') {
      mileage = 'New';
    } else if (data.mileage) {
      const mi = parseInt(data.mileage);
      mileage = mi > 0 ? mi.toLocaleString() + ' mi' : null;
    }

    // Photos from card-gallery light DOM, upgrade /large/ → /xxlarge/ for better resolution
    const photos = [...new Set(
      Array.from(card.querySelectorAll('card-gallery img'))
        .map(img => (img.src || '').replace('/large/', '/xxlarge/').replace(/\?.*$/, ''))
        .filter(src => src && src.startsWith('http'))
    )].slice(0, 8);

    const year  = data.year?.toString() || null;
    const make  = data.make || null;
    const model = data.model || null;
    const trim  = data.trim || null;

    return {
      vin:            data.vin || null,
      year,
      make,
      model,
      trim,
      title:          [year, make, model, trim].filter(Boolean).join(' '),
      price,
      mileage,
      exterior_color: data.exteriorColor || null,
      body_style:     data.bodyStyle || null,
      dealer_name:    dealerName,
      photos,
      listing_url:    listingUrl,
      source_url:     window.location.href,
      scraped_at:     new Date().toISOString(),
    };
  } catch (e) {
    return null;
  }
}

function scrapeVehicleFromPage() {
  const text = document.body.innerText || "";

  return {
    vin: extractVIN(text),
    year: extractYear(text),
    make: extractMake(text),
    model: extractModel(document.body),
    trim: extractTrim(document.body),
    price: extractPrice(text),
    mileage: extractMileage(text),
    photos: extractPhotosFromPage(),
    listing_url: window.location.href,
    source_url: window.location.href,
    scraped_at: new Date().toISOString(),
  };
}

// ── Config-driven scraping (for dealership sites) ─────────────────
function scrapeWithConfig(card, config) {
  const ext = config.inventory_page.extractors;
  const getText = (sel) => card.querySelector(sel)?.innerText?.trim() || null;
  const getAttr = (sel, attr) => card.querySelector(sel)?.getAttribute(attr) ||
    card.getAttribute(attr) || null;

  // Get photos — strip query params for full resolution
  const photoEls = Array.from(card.querySelectorAll(ext.photos.selector));
  const photos = [...new Set(
    photoEls
      .map(img => (img.src || img.dataset.src || '').replace(/\?.*$/, ''))
      .filter(src => src && src.startsWith('http'))
  )].slice(0, 8);

  // Get mileage — filter for the one containing "miles" or "mi"
  const mileageEls = Array.from(card.querySelectorAll(ext.mileage.selector));
  const mileage = mileageEls
    .find(el => /miles|mi\b/i.test(el.innerText))?.innerText?.trim() || null;

  // Get link — try href first, then common data attributes used by some platforms
  const linkEl = card.querySelector(ext.link.selector);
  const href = linkEl?.getAttribute('href') ||
               linkEl?.getAttribute('data-vdp-url') ||
               linkEl?.getAttribute('data-href') ||
               linkEl?.getAttribute('data-url') ||
               card.getAttribute('data-vdp-url') || '';
  const listingUrl = href.startsWith('http') ? href :
    (href ? window.location.origin + href : '');

  // make: try dedicated make selector first, fall back to parsing title text
  const titleText = getText(ext.title.selector) || '';
  const makeText  = ext.make?.selector ? (getText(ext.make.selector) || titleText) : titleText;

  return {
    vin: getAttr(ext.vin.selector, ext.vin.attribute),
    year: extractYear(titleText),
    make: extractMake(makeText),
    model: extractModel(card),
    trim: extractTrim(card),
    price: getText(ext.price.selector),
    mileage: mileage,
    photos: photos,
    listing_url: listingUrl,
    source_url: window.location.href,
    dealership: config.dealership_name,
    scraped_at: new Date().toISOString(),
  };
}

function injectConfigDrivenButtons(cards, config) {
  cards.forEach(card => {
    if (card.querySelector(`.${BUTTON_CLASS}`)) return;
    const vehicleData = scrapeWithConfig(card, config);
    // Require at minimum a valid detail page link — VIN/price can come from the VDP
    const hasLink = vehicleData.listing_url &&
      vehicleData.listing_url !== window.location.origin &&
      vehicleData.listing_url !== window.location.href;
    if (!hasLink && !vehicleData.vin && !vehicleData.price) return;
    const btn = createImportButton(vehicleData);
    card.setAttribute(INJECTED_ATTR, "true");
    const footer = card.querySelector('[class*="footer"],[class*="actions"],[class*="price"]');
    if (footer) footer.appendChild(btn);
    else card.appendChild(btn);
  });
}

// ── VDP detection ─────────────────────────────────────────────
const VDP_URL_PATTERNS = [
  '/vdp/', '/vehicle-details/', '/vehicle/', '/detail/',
  '/used/', '/new/', '/certified/', '/inventory/',
  '/cars/', '/pre-owned/',
];

function isVdpPage() {
  const hostname = window.location.hostname;
  const path = window.location.pathname.toLowerCase();
  // Cars.com VDP — UUID-based URL, not VIN
  if (hostname === 'www.cars.com' && path.includes('/vehicledetail/')) return true;
  // VIN in URL is the strongest signal
  if (VIN_REGEX.test(path)) return true;
  // Known VDP path patterns
  if (VDP_URL_PATTERNS.some(p => path.includes(p))) return true;
  // Has a vehicle title with year and a price element
  const h1 = document.querySelector('h1')?.innerText || '';
  const hasVehicleTitle = YEAR_REGEX.test(h1) && CAR_MAKES.some(m => h1.toLowerCase().includes(m));
  const hasPrice = !!document.querySelector('[class*="price"],[class*="Price"]');
  return hasVehicleTitle && hasPrice;
}

// ── VDP import button ──────────────────────────────────────────
function injectVdpButton(config) {
  if (document.querySelector(`.${BUTTON_CLASS}`)) return;

  const safeQ    = (sel) => { try { return sel ? document.querySelector(sel) : null; } catch (e) { return null; } };
  const safeQAll = (sel) => { try { return sel ? Array.from(document.querySelectorAll(sel)) : []; } catch (e) { return []; } };
  const getText  = (sel) => safeQ(sel)?.innerText?.trim() || null;
  const dp = config?.detail_page?.extractors || {};
  const skipPatterns = ['thumb_', '/thumb/', 'thumbnail', 'logo', 'icon', 'badge', 'placeholder', '1x1', 'spacer'];

  // ── VIN ───────────────────────────────────────────────────────
  let vin = (window.location.pathname.match(VIN_REGEX) || [])[1]?.toUpperCase() || null;
  if (!vin && dp.vin?.selector) vin = getText(dp.vin.selector)?.match(/[A-HJ-NPR-Z0-9]{17}/i)?.[0] || null;
  if (!vin) vin = (document.body.innerText.match(VIN_REGEX) || [])[1] || null;

  // ── Title → year / make / model ───────────────────────────────
  const titleEl  = document.querySelector('h1, .vehicle-title, [class*="vehicle-name"]');
  const titleText = titleEl?.innerText?.trim() || document.title || '';
  const year  = (titleText.match(YEAR_REGEX) || [])[0] || null;
  const make  = extractMake(titleText);
  const model = extractModel(document.body) ||
    titleText.replace(YEAR_REGEX, '').replace(new RegExp(CAR_MAKES.join('|'), 'gi'), '').trim().split(/\s+/).slice(0, 3).join(' ') ||
    null;

  // ── Price ─────────────────────────────────────────────────────
  let price = null;
  if (dp.price?.selector) price = getText(dp.price.selector);
  if (!price) {
    const xPrice = (el) => {
      if (!el) return null;
      const t = el.innerText?.trim() || '';
      const m = t.match(/\$[\d,]+/);
      return m ? m[0] : (t.length < 15 && /\d/.test(t) ? t : null);
    };
    // Final/internet price first
    price = xPrice(safeQ('dd.final-price.internetPrice .price-value')) ||
            xPrice(safeQ('dd[class*="internetPrice"] .price-value')) ||
            xPrice(safeQ('[class*="internet-price"] .price-value')) ||
            xPrice(safeQ('[class*="our-price"]')) ||
            xPrice(safeQ('[class*="online-price"]'));

    // Label-scan: find final price by reading dt label text
    if (!price) {
      const FINAL_KW = ['freight', 'destination', 'internet price', 'our price',
        'online price', 'total price', 'final price', 'dealer price'];
      const labels = safeQAll('dl dt, dl th');
      for (const label of labels) {
        const t = label.innerText?.toLowerCase() || '';
        if (FINAL_KW.some(kw => t.includes(kw))) {
          const sib = label.nextElementSibling;
          const p = xPrice(sib?.querySelector?.('.price-value') || sib);
          if (p) { price = p; break; }
        }
      }
    }

    // Last resort
    if (!price) {
      price = xPrice(safeQ('dd.askingPrice .price-value')) ||
              xPrice(safeQ('[class*="sale-price"]')) ||
              xPrice(safeQ('[class*="asking-price"]'));
    }
  }

  // ── Mileage ───────────────────────────────────────────────────
  let mileage = null;
  if (dp.mileage?.selector) mileage = getText(dp.mileage.selector);
  if (!mileage) {
    const els = safeQAll('.highlight-badge, [class*="mileage"], [class*="miles"]');
    mileage = els.find(el => /miles|mi\b/i.test(el.innerText))?.innerText?.trim() || null;
  }

  // ── Photos — try config selector, then CDN extraction, then generic ──
  let photos = [];
  if (dp.photos?.selector) {
    photos = safeQAll(dp.photos.selector)
      .map(img => (img.getAttribute('data-src') || img.src || '').replace(/\?.*$/, ''))
      .filter(src => src && src.startsWith('http') && !skipPatterns.some(p => src.toLowerCase().includes(p)))
      .filter((s, i, a) => a.indexOf(s) === i).slice(0, 40);
  }
  if (!photos.length) {
    // pictures.dealer.com CDN extraction from raw HTML
    const cdnMatches = document.documentElement.innerHTML.match(/https:\/\/pictures\.dealer\.com\/[^"'\s>\\]+/g) || [];
    const cdnSet = new Set();
    cdnMatches.forEach(url => {
      const clean = url.replace(/\\u0026.*/, '').replace(/\?.*/, '').replace(/\\.*/, '');
      if (clean.match(/\.(jpg|jpeg|png|webp)$/i)) cdnSet.add(clean);
    });
    photos = Array.from(cdnSet).filter(s => !skipPatterns.some(p => s.toLowerCase().includes(p))).slice(0, 40);
  }
  if (!photos.length) {
    photos = safeQAll('img')
      .map(img => (img.getAttribute('data-src') || img.src || '').replace(/\?.*$/, ''))
      .filter(src => src.startsWith('http') && src.match(/\.(jpg|jpeg|webp|png)/i))
      .filter(src => !skipPatterns.some(p => src.toLowerCase().includes(p)))
      .filter((s, i, a) => a.indexOf(s) === i).slice(0, 40);
  }

  if (!vin && !price) return; // Not enough data to import

  const vehicleData = {
    vin,
    year,
    make,
    model,
    price,
    mileage,
    photos,
    photos_for_video: photos.slice(0, 20),
    listing_url: window.location.href,
    source_url:  window.location.href,
    dealership:  window.location.hostname,
    scraped_at:  new Date().toISOString(),
    vdp_import:  true, // tells background.js to skip opening a detail tab
  };

  // Fixed button — bottom-right fallback (always present)
  const fixedBtn = createImportButton(vehicleData);
  fixedBtn.style.cssText += 'position:fixed;bottom:20px;right:20px;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
  document.body.appendChild(fixedBtn);

  // Inline button — inserted near price/CTA area (fresh button, not a clone)
  // Try selectors from most specific to most generic
  const INLINE_ANCHORS = [
    'dl.pricing-detail',          // JBA / Dealer Inspire
    '[class*="pricing-detail"]',
    '[class*="price-block"]',
    '[class*="priceBlock"]',
    '[class*="vehicle-price"]',
    '[class*="price-box"]',
    '[class*="pricing"]',
    '.price-section',
    '[class*="vdp-cta"]',
    '[class*="vehicle-cta"]',
    '[class*="cta-section"]',
    'h1',                          // last resort — right after the title
  ];
  let injected = false;
  for (const sel of INLINE_ANCHORS) {
    const anchor = safeQ(sel);
    if (anchor) {
      const inlineBtn = createImportButton(vehicleData);
      inlineBtn.style.display = 'block';
      inlineBtn.style.marginTop = '12px';
      inlineBtn.style.marginBottom = '8px';
      anchor.insertAdjacentElement('afterend', inlineBtn);
      injected = true;
      break;
    }
  }
}


// ── Extraction helpers ────────────────────────────────────────
function extractVIN(text) {
  const match = text.match(VIN_REGEX);
  return match ? match[1].toUpperCase() : null;
}

function extractYear(text) {
  const match = text.match(YEAR_REGEX);
  return match ? match[0] : null;
}

function extractMake(text) {
  const lower = text.toLowerCase();
  return CAR_MAKES.find(make => lower.includes(make)) || null;
}

function extractModel(el) {
  // Look for title/heading elements that usually contain year/make/model
  const headings = el.querySelectorAll("h1,h2,h3,h4,[class*='title'],[class*='name']");
  for (const h of headings) {
    const text = h.innerText || "";
    if (YEAR_REGEX.test(text) && CAR_MAKES.some(m => text.toLowerCase().includes(m))) {
      // Strip year and make to get model
      const cleaned = text
        .replace(YEAR_REGEX, "")
        .replace(new RegExp(CAR_MAKES.join("|"), "gi"), "")
        .trim();
      return cleaned.split(/\s+/).slice(0, 2).join(" ") || null;
    }
  }
  return null;
}

function extractTrim(el) {
  // Trim is often in a subtitle or separate element
  const trimEls = el.querySelectorAll('[class*="trim"],[class*="subtitle"],[class*="sub-title"]');
  for (const t of trimEls) {
    const text = (t.innerText || "").trim();
    if (text && text.length < 50) return text;
  }
  return null;
}

function extractPrice(text) {
  const match = text.match(PRICE_REGEX);
  return match ? match[0] : null;
}

function extractMileage(text) {
  const match = text.match(/[\d,]+ ?(mi|miles|km)/i);
  return match ? match[0] : null;
}

function extractListingUrl(card) {
  // Find the link on the card that goes to the full listing
  const link = card.querySelector("a[href]");
  if (link) {
    const href = link.getAttribute("href");
    if (href.startsWith("http")) return href;
    return window.location.origin + href;
  }
  return window.location.href;
}

function extractPhotosFromCard(card) {
  const photos = [];
  const imgs = card.querySelectorAll("img");

  imgs.forEach(img => {
    const src = img.src || img.dataset.src || img.dataset.lazySrc || "";
    if (src && isValidPhotoUrl(src)) {
      photos.push(getLargestVariant(src));
    }
  });

  return [...new Set(photos)].slice(0, 8);
}

function extractPhotosFromPage() {
  const photos = [];

  // Look for gallery/slider containers first
  const gallerySelectors = [
    '[class*="gallery"] img',
    '[class*="slider"] img',
    '[class*="carousel"] img',
    '[class*="photo"] img',
    '[class*="image-viewer"] img',
  ];

  for (const sel of gallerySelectors) {
    document.querySelectorAll(sel).forEach(img => {
      const src = img.src || img.dataset.src || "";
      if (src && isValidPhotoUrl(src)) {
        photos.push(getLargestVariant(src));
      }
    });
    if (photos.length >= 3) break;
  }

  // Fallback — all images on page
  if (photos.length < 3) {
    document.querySelectorAll("img").forEach(img => {
      const src = img.src || img.dataset.src || "";
      if (src && isValidPhotoUrl(src)) {
        photos.push(getLargestVariant(src));
      }
    });
  }

  return [...new Set(photos)].slice(0, 8);
}


function isValidPhotoUrl(url) {
  if (!url || !url.startsWith("http")) return false;
  const lower = url.toLowerCase();
  const skipPatterns = [
    "thumb", "icon", "logo", "badge", "avatar", "sprite",
    "placeholder", "blank", "pixel", "tracking", "dealer-logo",
    ".gif", "data:image", "1x1", "spacer",
  ];
  if (skipPatterns.some(p => lower.includes(p))) return false;
  const validExts = [".jpg", ".jpeg", ".png", ".webp"];
  const hasValidExt = validExts.some(e => lower.includes(e));
  const isKnownCDN = [
    "cstatic-images", "cargurus", "autotrader", "dealer.com",
    "dealerinspire", "cloudfront", "amazonaws", "imgix",
  ].some(cdn => lower.includes(cdn));
  return hasValidExt || isKnownCDN;
}


/**
 * Try to get the largest available variant of a photo URL.
 * Many CDNs use size suffixes — swap for the largest.
 */
function getLargestVariant(url) {
  return url
    .replace(/[_-](thumb|small|medium|thumbnail)/gi, "_large")
    .replace(/\/thumb\//gi, "/large/")
    .replace(/\/small\//gi, "/large/")
    .replace(/size=\w+/gi, "size=xxlarge");
}


// ── Button injection ──────────────────────────────────────────
/**
 * Create the Import to DealersOrbit button.
 */
function createImportButton(vehicleData) {
  const btn = document.createElement("button");
  btn.className = BUTTON_CLASS;
  btn.textContent = "⊕ Import to DealersOrbit";
  btn.title = "Add this vehicle to DealersOrbit ad generation queue";

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;

    btn.disabled = true;
    btn.textContent = "Adding to queue...";
    btn.style.background = "#6b7280";

    // Set a timeout to re-enable button if message fails
    const timeout = setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "↺ Reload page to retry";
      btn.style.background = "#dc2626";
      btn.title = "Import timed out. Reload the page and try again.";
      btn.onclick = () => window.location.reload();
      console.log("DealersOrbit: Import timed out — re-enabling button");
    }, 15000); // 15 second timeout

    try {
      const response = await chrome.runtime.sendMessage({
        type: "ADD_TO_QUEUE",
        vehicle: vehicleData,
      });
      clearTimeout(timeout);

      if (response?.success) {
        btn.textContent = "✓ In Queue";
        btn.style.background = "#16a34a";
      } else if (response?.trial_blocked) {
        // Out of free trial — importing is disabled. Turn the button into an
        // upgrade prompt instead of silently resetting.
        btn.disabled = false;
        btn.textContent = response.error === "TRIAL_EXPIRED"
          ? "🔒 Free trial ended — Upgrade"
          : "🔒 Trial limit reached — Upgrade";
        btn.style.background = "#f59e0b";
        btn.title = "Upgrade your DealersOrbit account to keep importing vehicles.";
        btn.onclick = () => window.open("https://dealersorbit.com/#pricing", "_blank");
      } else {
        btn.disabled = false;
        btn.textContent = "⊕ Import to DealersOrbit";
        btn.style.background = "";
      }
    } catch (err) {
      clearTimeout(timeout);
      console.error("DealersOrbit: Failed to send message:", err);

      // Check if extension context was invalidated
      if (err.message?.includes("Extension context invalidated") ||
        err.message?.includes("context invalidated")) {
        btn.disabled = false;
        btn.textContent = "⚠️ Please close & reopen this tab";
        btn.style.background = "#dc2626";
        btn.title = "The DealersOrbit extension was updated. Close this tab and open a new one to continue.";
      } else {
        // Generic retry error
        btn.disabled = false;
        btn.textContent = "↺ Reload page to retry";
        btn.style.background = "#dc2626";
        btn.title = "Something went wrong. Reload the page and try again.";
        btn.onclick = () => window.location.reload();
      }
    }
  });
  return btn;
}


/**
 * Inject Import buttons on all car cards (inventory page mode).
 */
function injectInventoryButtons(cards) {
  cards.forEach(card => {
    // Skip if already injected
    if (card.querySelector(`.${BUTTON_CLASS}`)) return;

    const vehicleData = scrapeVehicleFromCard(card);

    // Only inject if we got at least some useful data
    if (!vehicleData.year && !vehicleData.vin && !vehicleData.price) return;

    const btn = createImportButton(vehicleData);
    card.setAttribute(INJECTED_ATTR, "true");

    // Try to find a good place to insert the button
    const footer = card.querySelector(
      '[class*="footer"],[class*="actions"],[class*="cta"],[class*="buttons"]'
    );
    if (footer) {
      footer.appendChild(btn);
    } else {
      // Append to the bottom of the card
      card.style.position = "relative";
      card.appendChild(btn);
    }
  });
}


/**
 * Inject a single Import button for single listing pages.
 */
function injectSingleListingButton() {
  // Avoid double injection
  if (document.querySelector(`.${BUTTON_CLASS}`)) return;

  const vehicleData = scrapeVehicleFromPage();
  const btn = createImportButton(vehicleData);

  // Find a good place — price box, CTA area, or top of page
  const insertTargets = [
    '[class*="price-box"]',
    '[class*="vehicle-summary"]',
    '[class*="vehicle-info"]',
    '[class*="cta-section"]',
    '[class*="contact-dealer"]',
    "main",
    "article",
  ];

  for (const sel of insertTargets) {
    const el = document.querySelector(sel);
    if (el) {
      el.insertAdjacentElement("afterbegin", btn);
      return;
    }
  }

  // Last resort — insert after the first h1
  const h1 = document.querySelector("h1");
  if (h1) h1.insertAdjacentElement("afterend", btn);
}

// Helper to Title Case a string
function toTitleCase(str) {
  return str.replace(/\w\S*/g, txt =>
    txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
}

async function ensurePublicPrivacy() {
  // Open privacy picker
  const privacyBtn = document.querySelector('[aria-label*="Edit privacy"]');
  if (!privacyBtn) {
    console.log("DealersOrbit: privacy button not found, skipping");
    return;
  }
  privacyBtn.click();
  await new Promise(r => setTimeout(r, 1200));

  // Select Public radio
  const publicRadio = document.querySelector('input[type="radio"][name="-0"]');
  if (publicRadio && !publicRadio.checked) {
    publicRadio.click();
    await new Promise(r => setTimeout(r, 600));
  }

  // Click Done button
  const doneBtn = Array.from(document.querySelectorAll('span')).find(
    s => s.textContent.trim() === 'Done'
  );
  if (doneBtn) {
    doneBtn.closest('[role="button"]')?.click() || doneBtn.click();
    await new Promise(r => setTimeout(r, 800));
    console.log("DealersOrbit: privacy set to Public");
  } else {
    // fallback: Back button
    const backBtn = document.querySelector('[aria-label="Back"]');
    backBtn?.click();
    await new Promise(r => setTimeout(r, 800));
  }
}

async function enableAiLabel() {
  // Find the "AI label off" button by its visible text and click it to open the dialog
  const aiLabelSpan = Array.from(document.querySelectorAll('span'))
    .find(el => el.textContent.trim() === 'AI label off');

  if (!aiLabelSpan) {
    console.log('DealersOrbit: AI label button not found, skipping');
    return;
  }

  const aiLabelBtn = aiLabelSpan.closest('[role="button"]') || aiLabelSpan.parentElement;
  aiLabelBtn.click();
  await sleep(1000);

  // Wait for the labeling dialog
  const dialog = await waitForElement('[aria-label="Labeling your content"]', 5000);
  if (!dialog) {
    console.log('DealersOrbit: AI label dialog did not appear, skipping');
    return;
  }

  // Toggle the switch on if it isn't already
  const toggle = dialog.querySelector('input[aria-label="Add AI label"][role="switch"]') ||
                 document.querySelector('input[aria-label="Add AI label"][role="switch"]');

  if (toggle && toggle.getAttribute('aria-checked') !== 'true') {
    toggle.click();
    await sleep(500);
  }

  // Dismiss with "Got it"
  const gotItBtn = document.querySelector('[aria-label="Got it"]');
  if (gotItBtn) {
    gotItBtn.click();
    await sleep(600);
    console.log('DealersOrbit: AI label enabled');
  }
}

async function openPostComposer() {
  // Step 1: click the "What's on your mind?" area to open the full composer
  const createPostBtn = Array.from(document.querySelectorAll('[role="button"]')).find(
    el => /what.s on your mind/i.test(el.textContent)
  );
  if (!createPostBtn) throw new Error("DealersOrbit: 'What’s on your mind' button not found");
  createPostBtn.click();
  await new Promise(r => setTimeout(r, 1200));

  // Step 2: wait for the full composer dialog (contenteditable) to appear
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const check = setInterval(() => {
      if (document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]')) {
        clearInterval(check);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(check);
        reject(new Error("DealersOrbit: composer did not open"));
      }
    }, 300);
  });
  await new Promise(r => setTimeout(r, 500));
  console.log("DealersOrbit: composer opened");
}

async function addCaptionToPost(caption) {
  // After photo attachment Facebook transitions to photo-post mode — a new dialog
  // layer replaces the text composer. Scope the search to the active dialog so we
  // don't accidentally write into the home-feed "What's on your mind?" box behind it.
  const dialog =
    document.querySelector('[role="dialog"]') ||
    document.querySelector('[aria-modal="true"]');

  const editor =
    dialog?.querySelector('div[contenteditable="true"][data-lexical-editor="true"]') ||
    document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');

  if (!editor) throw new Error("DealersOrbit: caption editor not found");
  editor.focus();
  await new Promise(r => setTimeout(r, 300));
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  await new Promise(r => setTimeout(r, 100));

  // The popup wrote the caption to the real clipboard (in user-gesture context).
  // execCommand('paste') with clipboardRead permission pastes the real clipboard
  // into the focused Lexical editor, which preserves newlines as paragraphs.
  document.execCommand('paste', false, null);

  await new Promise(r => setTimeout(r, 400));
  console.log("DealersOrbit: caption inserted");
}

// Marketplace description is a <textarea> (React-controlled). Fill it instantly
// with one execCommand('insertText') — same selectAll/delete + execCommand
// approach as addCaptionToPost, but insertText (no clipboard dependency) and in
// a single shot instead of humanType's per-character loop.
async function fillMarketplaceDescription(description) {
  const textarea =
    document.querySelector('textarea[aria-label="Description"]') ||
    document.querySelector('textarea[name="description"]') ||
    document.querySelector('textarea');

  if (!textarea) {
    console.log('DealersOrbit: description field not found');
    return false;
  }

  textarea.focus();
  await sleep(200);

  // Clear any existing content
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  await sleep(50);

  // Instant fill — whole string at once (newlines preserved)
  document.execCommand('insertText', false, description);

  // Fire the same events humanType ends with so React registers the value
  textarea.dispatchEvent(new InputEvent('input', {
    data: description, inputType: 'insertText', bubbles: true,
  }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);

  console.log('DealersOrbit: description filled instantly');
  return true;
}

/**
 * Fetch a photo and return it as a File object.
 * Tries a direct fetch first (works for CDNs that send permissive CORS headers).
 * If that fails — CORS block, 403 hotlink protection, or any network error —
 * falls back silently to the background service worker, which runs in the
 * extension context and is not subject to CORS restrictions.
 */
async function fetchPhotoFile(url, filename) {
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const blob = await resp.blob();
      return new File([blob], filename, { type: blob.type || 'image/jpeg' });
    }
  } catch (_) {}

  // Direct fetch failed — proxy through background (bypasses CORS/hotlink).
  // Background returns base64 string because Chrome message passing uses JSON
  // and cannot transfer ArrayBuffers directly.
  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: 'FETCH_FILES', files: [{ url, isVideo: false }] },
      (resp) => {
        const result = resp?.results?.[0];
        if (!result?.ok || !result.base64) { resolve(null); return; }
        try {
          const binary = atob(result.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: result.contentType || 'image/jpeg' });
          resolve(new File([blob], filename, { type: blob.type }));
        } catch (_) { resolve(null); }
      }
    );
  });
}

async function uploadFilesToPost(photos, videoUrl) {
  const photoUrls = photos || [];

  if (photoUrls.length === 0 && !videoUrl) {
    console.log("DealersOrbit: no files to upload, skipping");
    return;
  }

  const fileInput =
    document.querySelector('input[type="file"][multiple]') ||
    document.querySelector('input[type="file"]');

  if (!fileInput) throw new Error("DealersOrbit: file input not found on page");

  console.log("DealersOrbit: file input accept:", fileInput.accept);
  const acceptsVideo = /video/i.test(fileInput.accept);

  if (videoUrl && acceptsVideo && photoUrls.length > 0) {
    // ── Two-pass: video first, then photos once Facebook finishes processing ──

    // Start downloading photos in the background while we deal with video
    const photoDownloadPromise = Promise.all(
      photoUrls.map((url, i) => fetchPhotoFile(url, `photo-${i + 1}.jpg`))
    );

    // Pass 1: inject video only → opens the composer
    console.log('DealersOrbit: Downloading video...');
    try {
      const resp = await fetch(videoUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        console.log('DealersOrbit: video size:', (blob.size / 1024 / 1024).toFixed(1), 'MB');
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'vehicle-ad.mp4', { type: 'video/mp4' }));
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        console.log('DealersOrbit: Video injected — waiting for composer...');
      } else {
        console.log('DealersOrbit: video download failed:', resp.status);
      }
    } catch (err) {
      console.log('DealersOrbit: video fetch error:', err.message);
    }

    // Wait for the Lexical editor (composer) to open
    await new Promise((resolve) => {
      const deadline = Date.now() + 15000;
      const check = setInterval(() => {
        const editor = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');
        if (editor || Date.now() > deadline) { clearInterval(check); resolve(); }
      }, 300);
    });

    // Wait for Facebook to finish processing the video.
    // Facebook shows a "Processing video…" or spinner on the thumbnail while it works.
    // We watch for a <video> element to appear inside the dialog (thumbnail ready)
    // and for any "processing" text to disappear. Cap at 45s.
    console.log('DealersOrbit: Waiting for Facebook to finish processing video...');
    await new Promise((resolve) => {
      const deadline = Date.now() + 45000;
      const check = setInterval(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const ctx    = dialog || document;
        const videoEl        = ctx.querySelector('video');
        const stillProcessing = ctx.innerText?.toLowerCase().includes('processing');
        if ((videoEl && !stillProcessing) || Date.now() > deadline) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
    await sleep(1500);
    console.log('DealersOrbit: Video processed — injecting photos now...');

    // Pass 2: find the file input inside the now-open composer and add photos
    const photoFiles = (await photoDownloadPromise).filter(Boolean);
    if (photoFiles.length > 0) {
      // After the composer opens, Facebook renders another file input inside the dialog
      const composerInput =
        document.querySelector('[role="dialog"] input[type="file"]') ||
        document.querySelector('input[type="file"][multiple]') ||
        document.querySelector('input[type="file"]');

      if (composerInput) {
        const dt = new DataTransfer();
        photoFiles.forEach(f => dt.items.add(f));
        composerInput.files = dt.files;
        composerInput.dispatchEvent(new Event('change', { bubbles: true }));
        composerInput.dispatchEvent(new Event('input', { bubbles: true }));
        console.log(`DealersOrbit: ${photoFiles.length} photos added after video`);
        await sleep(3000);
      } else {
        console.log('DealersOrbit: Could not find composer input for photos');
      }
    }

  } else {
    // No video (or photos-only) — single pass, original behaviour
    const allFiles = [];

    if (videoUrl && acceptsVideo) {
      try {
        const resp = await fetch(videoUrl);
        if (resp.ok) {
          const blob = await resp.blob();
          allFiles.push(new File([blob], 'vehicle-ad.mp4', { type: 'video/mp4' }));
        }
      } catch (err) {
        console.log('DealersOrbit: video fetch error:', err.message);
      }
    }

    for (let i = 0; i < photoUrls.length; i++) {
      const file = await fetchPhotoFile(photoUrls[i], `photo-${i + 1}.jpg`);
      if (file) allFiles.push(file);
    }

    if (allFiles.length > 0) {
      const dt = new DataTransfer();
      allFiles.forEach(f => dt.items.add(f));
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      console.log(`DealersOrbit: attached ${allFiles.length} files`);
    }

    // Wait for composer
    await new Promise((resolve) => {
      const deadline = Date.now() + 12000;
      const check = setInterval(() => {
        const editor = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');
        if (editor || Date.now() > deadline) { clearInterval(check); resolve(); }
      }, 300);
    });
  }

  await sleep(1000);
  console.log("DealersOrbit: photo composer ready");
}

function showDealersOrbitBanner(message) {
  document.querySelector(".dealersorbit-post-banner")?.remove();

  const banner = document.createElement("div");
  banner.className = "dealersorbit-post-banner";
  banner.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #4267B2;
    color: white;
    padding: 14px 18px;
    border-radius: 10px;
    font-family: -apple-system, sans-serif;
    font-size: 14px;
    font-weight: 600;
    z-index: 999999;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    min-width: 260px;
    max-width: 320px;
    line-height: 1.5;
  `;
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="font-size:18px">📘</span>
      <strong>DealersOrbit FB Post</strong>
    </div>
    <div class="dealersorbit-banner-msg" style="font-weight:400;font-size:13px">${message}</div>
  `;
  document.body.appendChild(banner);
  return banner;
}

function updateBanner(message, type = 'working') {
  const banner = document.querySelector(".dealersorbit-post-banner");
  if (!banner) return;

  const msgEl = banner.querySelector(".dealersorbit-banner-msg");
  if (msgEl) msgEl.textContent = message;

  if (type === 'success') {
    banner.style.background = '#16a34a';
    if (!banner.querySelector('#dealersorbit-post-dismiss')) {
      const btn = document.createElement('button');
      btn.id = 'dealersorbit-post-dismiss';
      btn.textContent = 'Dismiss';
      btn.style.cssText = `
        margin-top:8px;background:transparent;color:white;
        border:1px solid rgba(255,255,255,0.5);padding:4px 10px;
        border-radius:4px;cursor:pointer;font-size:12px;display:block
      `;
      btn.onclick = () => banner.remove();
      banner.appendChild(btn);
    }
    setTimeout(() => banner.remove(), 10000);
  } else if (type === 'error') {
    banner.style.background = '#dc2626';
    if (!banner.querySelector('#dealersorbit-post-dismiss')) {
      const btn = document.createElement('button');
      btn.id = 'dealersorbit-post-dismiss';
      btn.textContent = 'Dismiss';
      btn.style.cssText = `
        margin-top:8px;background:transparent;color:white;
        border:1px solid rgba(255,255,255,0.5);padding:4px 10px;
        border-radius:4px;cursor:pointer;font-size:12px;display:block
      `;
      btn.onclick = () => banner.remove();
      banner.appendChild(btn);
    }
  }
}

async function tryFacebookPostFlow() {
  const { fb_post } = await chrome.storage.local.get("fb_post");
  if (!fb_post) return;
  const age = Date.now() - new Date(fb_post.created_at).getTime();
  if (age > 10 * 60 * 1000) return;

  console.log("DealersOrbit: FB Post flow started", fb_post);
  showDealersOrbitBanner("Preparing post...");

  try {
    // Support both new flat `photos` array (from modal) and old exterior/interior split
    const flatPhotos = fb_post.photos && fb_post.photos.length > 0
      ? fb_post.photos
      : [...(fb_post.exterior_photos || []), ...(fb_post.interior_photos || [])];

    const hasMedia = fb_post.video_url || flatPhotos.length > 0;

    if (hasMedia) {
      // Setting files on the home-feed input triggers Facebook to open the
      // photo post composer directly — skip openPostComposer() to avoid a
      // second dialog being created for the text post.
      updateBanner("Uploading media...");
      await uploadFilesToPost(flatPhotos, fb_post.video_url || null);
    } else {
      updateBanner("Opening post composer...");
      await openPostComposer();
    }

    updateBanner("Setting privacy to Public...");
    await ensurePublicPrivacy();

    updateBanner("Adding AI label...");
    await enableAiLabel();

    updateBanner("Adding caption...");
    await addCaptionToPost(fb_post.caption);

    await chrome.storage.local.remove("fb_post");
    chrome.runtime.sendMessage({ type: "FB_POST_COMPLETE", job_id: fb_post.job_id });
    chrome.runtime.sendMessage({
      type: "MARK_LISTING_POSTED",
      vehicle: fb_post.vehicle,
      listing_url: fb_post.vehicle?.listing_url,
    });

    updateBanner("✓ Post ready! Review and click Post.", "success");
    console.log("DealersOrbit: FB Post flow complete");

  } catch (err) {
    console.error("DealersOrbit: FB Post flow failed:", err);
    updateBanner(`❌ ${err.message}`, "error");
  }
}

async function clickFirstGroup() {
  console.log('DealersOrbit: Looking for first group in sidebar...');

  // Find group items by looking for 'Last active' sibling text (sidebar items have this)
  const allSpans = document.querySelectorAll('span');
  let firstGroupEl = null;

  for (const span of allSpans) {
    if (span.textContent?.includes('Last active') &&
        span.closest('[role="listitem"], [role="link"], a')) {
      const clickable = span.closest('a, [role="link"]');
      if (clickable) {
        firstGroupEl = clickable;
        break;
      }
    }
  }

  // Fallback: any /groups/<id> link that isn't a feed/discover/joins page
  if (!firstGroupEl) {
    const groupLinks = document.querySelectorAll('a[href*="/groups/"]');
    for (const link of groupLinks) {
      const href = link.getAttribute('href') || '';
      if (href.includes('/groups/') &&
          !href.match(/\/groups\/?$/) &&
          !href.includes('/groups/feed') &&
          !href.includes('/groups/discover') &&
          !href.includes('/groups/joins')) {
        firstGroupEl = link;
        break;
      }
    }
  }

  if (!firstGroupEl) {
    console.log('DealersOrbit: No groups found in sidebar');
    return false;
  }

  const groupName = firstGroupEl.textContent?.trim().split('\n')[0] || 'Unknown Group';
  console.log(`DealersOrbit: Clicking group: ${groupName}`);
  firstGroupEl.click();
  await sleep(3000);
  return true;
}

async function clickWriteSomethingInGroup() {
  console.log('DealersOrbit: Looking for Write something button...');

  const allButtons = document.querySelectorAll('[role="button"]');
  let writeBtn = null;

  for (const btn of allButtons) {
    if (btn.textContent?.includes('Write something')) {
      writeBtn = btn;
      break;
    }
  }

  if (!writeBtn) {
    console.log('DealersOrbit: Write something button not found');
    return false;
  }

  console.log('DealersOrbit: Clicking Write something...');
  writeBtn.click();
  await sleep(2000);
  return true;
}

async function scrollToAddGroupsButton() {
  const allSpans = document.querySelectorAll('span');
  for (const span of allSpans) {
    if (span.textContent?.trim() === 'Add groups') {
      span.scrollIntoView({ behavior: 'smooth', block: 'center' });
      console.log('DealersOrbit: Scrolled to Add groups button');
      return;
    }
  }
}

async function tryFacebookGroupsFlow() {
  console.log('DealersOrbit: Starting Facebook Groups post flow...');

  const { fb_groups_post } = await chrome.storage.local.get('fb_groups_post');
  if (!fb_groups_post) {
    console.log('DealersOrbit: No fb_groups_post data found');
    return;
  }

  showDealersOrbitBanner('👥 DealersOrbit: Finding your groups...');

  try {
    updateBanner('👥 DealersOrbit: Selecting first group...');
    const groupClicked = await clickFirstGroup();

    if (!groupClicked) {
      updateBanner('❌ No groups found. Make sure you are a member of Facebook groups.', 'error');
      return;
    }

    await sleep(3000);
    updateBanner('👥 DealersOrbit: Opening post composer...');

    const composerOpened = await clickWriteSomethingInGroup();

    if (!composerOpened) {
      updateBanner('❌ Could not open composer. Try clicking Write something manually.', 'error');
      return;
    }

    await sleep(2000);

    updateBanner('👥 DealersOrbit: Adding caption...');
    await addCaptionToPost(fb_groups_post.caption);
    await sleep(500);

    updateBanner('👥 DealersOrbit: Uploading photos & video...');
    await uploadFilesToPost(fb_groups_post.photos, fb_groups_post.video_url);

    updateBanner('✅ Ready! Click Add Groups to share to more groups, then click Post.', 'success');
    await scrollToAddGroupsButton();
    setTimeout(() => document.querySelector('.dealersorbit-post-banner')?.remove(), 6000);

    await chrome.storage.local.remove('fb_groups_post');
    chrome.runtime.sendMessage({ type: 'FB_GROUPS_POST_COMPLETE' });
    chrome.runtime.sendMessage({
      type: 'MARK_LISTING_POSTED',
      vehicle: fb_groups_post.vehicle,
      listing_url: fb_groups_post.vehicle?.listing_url,
    });

  } catch (err) {
    console.error('DealersOrbit: Groups flow error:', err);
    updateBanner(`❌ Error: ${err.message}. Please try again.`, 'error');
  }
}

async function tryFacebookAutoFill() {
  const url = window.location.href;
  if (!url.includes("facebook.com/marketplace/create")) return;

  const { fb_listing } = await chrome.storage.local.get("fb_listing");
  if (!fb_listing) return;

  const age = Date.now() - new Date(fb_listing.created_at).getTime();
  if (age > 600000) return;

  console.log("DealersOrbit: Waiting for Facebook form to load...");
  await waitForElement('[aria-label="Location"]', 15000);
  await sleep(3000);

  const v = fb_listing.vehicle;
  console.log("DealersOrbit: Starting form fill...", v);

  // ── Step 1: Upload video first ────────────────────────────
  await uploadVideoToFacebook(fb_listing);
  await sleep(2000);

  // ── Step 1b: Upload photos after video ────────────────────
  await uploadPhotosToFacebook(fb_listing);
  await sleep(2000);

  // ── Step 2: Vehicle type (MUST come before Make/Model) ────
  await fillDropdown("Vehicle type", "Car/Truck");
  await sleep(2000); // wait for Make/Model fields to appear

  // ── Step 3: Year ──────────────────────────────────────────
  if (v.year) {
    await fillDropdown("Year", v.year);
    await sleep(1500);
  }

  // ── Step 4: Make ──────────────────────────────────────────
  if (v.make) {
    const makeFormatted = toTitleCase(v.make);

    // Wait until Make combobox is present
    let makeEl = null;
    for (let i = 0; i < 10; i++) {
      const comboboxes = Array.from(document.querySelectorAll('[role="combobox"]'));
      makeEl = comboboxes.find(el => el.innerText?.trim() === "Make");
      if (makeEl) break;
      await sleep(500);
    }

    if (makeEl) {
      makeEl.click();
      await sleep(1500);

      const options = Array.from(document.querySelectorAll('[role="option"]'));
      console.log(`DealersOrbit: Make options found: ${options.length}`);

      const match = options.find(el =>
        el.innerText?.trim().toLowerCase() === makeFormatted.toLowerCase()
      );

      if (match) {
        match.click();
        console.log(`DealersOrbit: ✓ Make → ${makeFormatted}`);
        await sleep(2500); // wait for Model field to appear
      } else {
        console.log(`DealersOrbit: ✗ Make "${makeFormatted}" not found in options`);
        document.body.click();
        await sleep(500);
      }
    } else {
      console.log("DealersOrbit: ✗ Make combobox not found");
    }
  }

  // ── Step 5: Model ─────────────────────────────────────────
  if (v.model) {
    // Wait for Model input to appear after Make is selected
    let modelInput = null;
    for (let i = 0; i < 10; i++) {
      const allInputs = Array.from(document.querySelectorAll('input[type="text"]'))
        .filter(el => !['Location', 'Search Facebook'].includes(el.getAttribute('aria-label')));
      modelInput = allInputs.find(el => {
        const label = el.closest('[class]')?.previousElementSibling?.innerText || '';
        const parent = el.parentElement?.parentElement?.innerText || '';
        return label.includes('Model') || parent.includes('Model');
      });
      if (modelInput) break;
      await sleep(500);
    }

    if (modelInput) {
      modelInput.focus();
      await sleep(300);

      // Type using native value setter so React picks it up
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeSetter.call(modelInput, v.model);
      modelInput.dispatchEvent(new Event('input', { bubbles: true }));
      modelInput.dispatchEvent(new Event('change', { bubbles: true }));

      console.log(`DealersOrbit: ✓ Model → ${v.model}`);
      await sleep(500);
    } else {
      console.log("DealersOrbit: ✗ Model input not found");
    }
  }

  // ── Step 6: Mileage ───────────────────────────────────────
  await sleep(500);
  if (v.mileage) {
    const mileageNum = v.mileage.replace(/[^0-9]/g, "");
    const allInputs = Array.from(document.querySelectorAll('input[type="text"]'))
      .filter(el => !['Location', 'Search Facebook'].includes(el.getAttribute('aria-label')));
    const mileageInput = allInputs.find(el => {
      const label = el.closest('[class]')?.previousElementSibling?.innerText || '';
      return label.toLowerCase().includes('mileage') || label.toLowerCase().includes('miles');
    }) || allInputs[2];
    if (mileageInput) {
      await humanType(mileageInput, mileageNum);
      await sleep(500);
    }
  }

  // ── Step 7: Price ─────────────────────────────────────────
  await sleep(500);
  if (fb_listing.price) {
    const priceNum = fb_listing.price.replace(/[^0-9]/g, "");
    const allInputs = Array.from(document.querySelectorAll('input[type="text"]'))
      .filter(el => !['Location', 'Search Facebook'].includes(el.getAttribute('aria-label')));
    const priceInput = allInputs.find(el => {
      const label = el.closest('[class]')?.previousElementSibling?.innerText || '';
      return label.toLowerCase().includes('price');
    }) || allInputs[1];
    if (priceInput) {
      await humanType(priceInput, priceNum);
      await sleep(500);
    }
  }

  // ── Step 8: Body style ────────────────────────────────────
  await sleep(1000);
  // Prefer extracted body_style from JBA spec table; fall back to model-name guess
  const bodyStyle = mapToFacebookBodyStyle(
    fb_listing.vehicle?.body_style || fb_listing.vehicle?.vehicle_type
  ) || mapToFacebookBodyStyle(guessBodyStyle(v.model || ""));
  console.log(`DealersOrbit: body style: ${fb_listing.vehicle?.body_style} → ${bodyStyle}`);
  await fillDropdown("Body style", bodyStyle || "Other");
  await sleep(1000);

  // ── Step 9: Exterior and Interior color ─────────────────
  const exteriorFbColor = mapToFacebookColor(fb_listing.vehicle?.exterior_color);
  const interiorFbColor = mapToFacebookColor(fb_listing.vehicle?.interior_color);

  console.log(`DealersOrbit: exterior color: ${fb_listing.vehicle?.exterior_color} → ${exteriorFbColor}`);
  console.log(`DealersOrbit: interior color: ${fb_listing.vehicle?.interior_color} → ${interiorFbColor}`);

  if (exteriorFbColor) {
    await fillDropdown("Exterior color", exteriorFbColor);
    await sleep(500);
  }
  if (interiorFbColor) {
    await fillDropdown("Interior color", interiorFbColor);
    await sleep(500);
  }

  // ── Step 10: Clean title checkbox ────────────────────────
  const cleanTitleCheckbox = document.querySelector(
    'input[type="checkbox"][name="title_status"], ' +
    'input[aria-label="This vehicle has a clean title."]'
  );
  if (cleanTitleCheckbox && cleanTitleCheckbox.getAttribute('aria-checked') !== 'true') {
    cleanTitleCheckbox.click();
    console.log("DealersOrbit: ✓ Clean title checked");
    await sleep(500);
  }

  // ── Step 11: Vehicle condition ─────────────────────────────
  await fillDropdown("Vehicle condition", "Excellent");
  await sleep(1000);

  // ── Step 12: Fuel type ────────────────────────────────────
  await fillDropdown("Fuel type", guessFuelType(v.make || "", v.model || ""));
  await sleep(1000);

  // ── Step 13: Description ──────────────────────────────────
  await sleep(1000);
  if (fb_listing.description) {
    await fillMarketplaceDescription(fb_listing.description);
  }

  showFbAutoFillBanner();
  console.log("DealersOrbit: Form fill complete.");
}

// ── Exterior/Interior color ────────────────────────────────
// TODO: Extract color from VIN decode or add color picker to review screen
// Skipping for now — user can select manually


async function fillDropdown(labelText, optionText) {
  const comboboxes = Array.from(document.querySelectorAll('[role="combobox"]'));
  console.log(`DealersOrbit: Looking for "${labelText}" among ${comboboxes.length} comboboxes:`,
    comboboxes.map(el => el.innerText?.trim().slice(0, 20)));

  const trigger = comboboxes.find(el =>
    el.innerText?.trim().toLowerCase().startsWith(labelText.toLowerCase())
  );
  // ... rest unchanged

  if (!trigger) {
    console.log(`DealersOrbit: Dropdown "${labelText}" not found`);
    return false;
  }

  // Scroll the field into view so the user can watch each dropdown fill in
  // (inputs auto-scroll on focus, but comboboxes don't — this keeps the lower
  // half of the form from filling off-screen and looking frozen).
  trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(400);

  trigger.click();
  await sleep(1500); // wait longer for options to load

  // Try multiple times — options may load slowly
  for (let attempt = 0; attempt < 3; attempt++) {
    const options = Array.from(document.querySelectorAll(
      '[role="option"], [role="menuitem"], [role="listitem"]'
    ));

    if (options.length > 0) {
      // Try exact match first
      let match = options.find(el =>
        el.innerText?.trim().toLowerCase() === optionText.toLowerCase()
      );
      // Then partial match
      if (!match) {
        match = options.find(el =>
          el.innerText?.trim().toLowerCase().includes(optionText.toLowerCase())
        );
      }
      // Then word match
      if (!match) {
        const words = optionText.toLowerCase().split(' ');
        match = options.find(el =>
          words.some(w => w.length > 3 &&
            el.innerText?.trim().toLowerCase().includes(w))
        );
      }

      if (match) {
        match.click();
        console.log(`DealersOrbit: ✓ "${labelText}" → "${match.innerText?.trim()}"`);
        await sleep(500);
        return true;
      }
    }

    await sleep(800); // wait and try again
  }

  // Close dropdown
  document.body.click();
  await sleep(300);
  console.log(`DealersOrbit: ✗ No match for "${optionText}" in "${labelText}" dropdown`);
  return false;
}


async function uploadPhotosToFacebook(fbListing) {
  // Use only reviewed photos — exterior, interior, additional
  // NOT unclassified/other
  const reviewedPhotos = fbListing.reviewed_photos || [];
  const photoUrls = reviewedPhotos.length > 0
    ? reviewedPhotos
    : (fbListing.vehicle?.photos_for_video || []).slice(0, 20);

  if (!photoUrls.length) return;

  // Find the photo upload button
  const uploadBtn = Array.from(document.querySelectorAll('[role="button"]'))
    .find(el => el.innerText?.includes("Add photos") ||
      el.innerText?.includes("drag and drop"));

  const fileInput = document.querySelector('input[type="file"][accept*="image"]');

  if (!fileInput) {
    console.log("DealersOrbit: Photo file input not found");
    return;
  }

  console.log(`DealersOrbit: Downloading ${Math.min(photoUrls.length, 20)} photos...`);

  try {
    // Download photos and convert to File objects
    const files = [];
    for (const url of photoUrls.slice(0, 20)) {
      const filename = url.split('/').pop().split('?')[0] || 'photo.jpg';
      const file = await fetchPhotoFile(url, filename);
      if (file) files.push(file);
      await sleep(100);
    }

    if (!files.length) return;

    // Create DataTransfer and add files
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    fileInput.files = dt.files;

    // Trigger change event so React picks it up
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));

    console.log(`DealersOrbit: Uploaded ${files.length} photos`);
    await sleep(2000);

  } catch (err) {
    console.error("DealersOrbit: Photo upload failed:", err);
  }
}

async function uploadVideoToFacebook(fbListing) {
  if (!fbListing.video_url) {
    console.log("DealersOrbit: No video URL — skipping video upload");
    return;
  }

  const videoInput = document.querySelector(
    'input[type="file"][accept*="video"]'
  );

  if (!videoInput) {
    console.log("DealersOrbit: Video file input not found");
    return;
  }

  console.log("DealersOrbit: Downloading video for Facebook upload...");

  try {
    const resp = await fetch(fbListing.video_url);
    if (!resp.ok) {
      console.log("DealersOrbit: Video download failed:", resp.status);
      return;
    }

    const blob = await resp.blob();
    const file = new File([blob], "vehicle-ad.mp4", { type: "video/mp4" });

    const dt = new DataTransfer();
    dt.items.add(file);
    videoInput.files = dt.files;

    videoInput.dispatchEvent(new Event("change", { bubbles: true }));
    videoInput.dispatchEvent(new Event("input", { bubbles: true }));

    console.log("DealersOrbit: ✓ Video uploaded to Facebook — waiting for processing...");
    await sleep(4000); // wait 4 seconds for Facebook to process

  } catch (err) {
    console.error("DealersOrbit: Video upload failed:", err);
  }
}

function mapToFacebookColor(colorStr) {
  if (!colorStr) return null;
  const c = colorStr.toLowerCase();

  const colorMap = [
    { fb: 'Black',     keywords: ['black', 'noir', 'ebony', 'onyx', 'midnight', 'carbon', 'phantom', 'jet'] },
    { fb: 'White',     keywords: ['white', 'pearl', 'ivory', 'cream', 'snow', 'frost', 'glacier', 'alpine', 'bright'] },
    { fb: 'Silver',    keywords: ['silver', 'metallic', 'chrome', 'platinum', 'sterling', 'aluminum', 'florett', 'lunar', 'stardust', 'blade', 'sonic'] },
    { fb: 'Gray',      keywords: ['gray', 'grey', 'graphite', 'slate', 'granite', 'storm', 'shadow', 'smoke', 'pewter', 'tungsten', 'machine'] },
    { fb: 'Charcoal',  keywords: ['charcoal', 'dark gray', 'dark grey', 'iron', 'magnetite', 'mineral'] },
    { fb: 'Blue',      keywords: ['blue', 'navy', 'sapphire', 'cobalt', 'azure', 'aqua', 'ocean', 'sky', 'aegean', 'portofino', 'atlantic', 'pacific', 'velocity', 'kinetic'] },
    { fb: 'Red',       keywords: ['red', 'crimson', 'scarlet', 'cherry', 'ruby', 'garnet', 'cardinal', 'flame', 'rally', 'radiant'] },
    { fb: 'Burgundy',  keywords: ['burgundy', 'maroon', 'wine', 'merlot', 'dark red', 'oxblood', 'sangria'] },
    { fb: 'Green',     keywords: ['green', 'forest', 'sage', 'olive', 'emerald', 'lime', 'hunter', 'jungle', 'army'] },
    { fb: 'Brown',     keywords: ['brown', 'bronze', 'copper', 'mocha', 'espresso', 'chestnut', 'walnut', 'cognac', 'terra'] },
    { fb: 'Tan',       keywords: ['tan', 'sand', 'desert', 'wheat', 'khaki', 'camel', 'parchment'] },
    { fb: 'Beige',     keywords: ['beige', 'champagne', 'vanilla', 'linen', 'cashmere', 'almond'] },
    { fb: 'Gold',      keywords: ['gold', 'golden', 'amber', 'harvest', 'canyon', 'metallic gold'] },
    { fb: 'Orange',    keywords: ['orange', 'tangerine', 'burnt', 'terra cotta', 'cayenne'] },
    { fb: 'Yellow',    keywords: ['yellow', 'lemon', 'solar', 'sunburst', 'canary', 'lightning'] },
    { fb: 'Purple',    keywords: ['purple', 'violet', 'plum', 'lavender', 'amethyst', 'grape'] },
    { fb: 'Pink',      keywords: ['pink', 'rose', 'blush', 'fuchsia', 'coral', 'salmon'] },
    { fb: 'Turquoise', keywords: ['turquoise', 'teal', 'cyan', 'seafoam', 'mint', 'caribbean'] },
    { fb: 'Off White', keywords: ['off white', 'off-white', 'eggshell', 'antique white'] },
  ];

  for (const mapping of colorMap) {
    for (const keyword of mapping.keywords) {
      if (c.includes(keyword)) return mapping.fb;
    }
  }

  // Fallback — try matching individual words
  const words = c.split(/[\s\-_]+/);
  for (const word of words) {
    for (const mapping of colorMap) {
      if (mapping.fb.toLowerCase() === word) return mapping.fb;
      if (mapping.keywords.includes(word)) return mapping.fb;
    }
  }

  return null;
}

function mapToFacebookBodyStyle(bodyStr) {
  if (!bodyStr) return null;
  const b = bodyStr.toLowerCase().trim();

  const bodyMap = [
    { fb: 'Coupe',       keywords: ['coupe', 'coup'] },
    { fb: 'Sedan',       keywords: ['sedan', 'saloon'] },
    { fb: 'Hatchback',   keywords: ['hatchback', 'hatch', '5-door', '3-door'] },
    { fb: 'SUV',         keywords: ['suv', 'sport utility', 'crossover', 'cuv'] },
    { fb: 'Truck',       keywords: ['truck', 'pickup', 'pick-up', 'pick up'] },
    { fb: 'Convertible', keywords: ['convertible', 'cabriolet', 'roadster', 'spyder', 'spider'] },
    { fb: 'Wagon',       keywords: ['wagon', 'estate', 'touring', 'sportwagon', 'sport wagon'] },
    { fb: 'Minivan',     keywords: ['minivan', 'mini van', 'van', 'minibus'] },
    { fb: 'Small Car',   keywords: ['small car', 'micro', 'mini', 'city car', 'subcompact'] },
  ];

  for (const mapping of bodyMap) {
    for (const keyword of mapping.keywords) {
      if (b.includes(keyword)) return mapping.fb;
    }
  }

  return 'Other';
}

function guessBodyStyle(model) {
  const m = model.toLowerCase();
  if (m.includes("suv") || m.includes("blazer") || m.includes("explorer") ||
    m.includes("tahoe") || m.includes("escalade") || m.includes("xt4") ||
    m.includes("xt5") || m.includes("telluride") || m.includes("sportage")) {
    return "SUV";
  }
  if (m.includes("truck") || m.includes("silverado") || m.includes("f-150") ||
    m.includes("ram") || m.includes("tacoma") || m.includes("tundra")) {
    return "Truck";
  }
  if (m.includes("van") || m.includes("minivan") || m.includes("odyssey") ||
    m.includes("sienna") || m.includes("carnival")) {
    return "Minivan";
  }
  if (m.includes("coupe") || m.includes("camaro") || m.includes("mustang") ||
    m.includes("corvette") || m.includes("challenger")) {
    return "Coupe";
  }
  if (m.includes("convert") || m.includes("cabrio") || m.includes("spider")) {
    return "Convertible";
  }
  // Default to Sedan for cars
  return "Sedan";
}

function guessFuelType(make, model) {
  const combined = (make + " " + model).toLowerCase();

  // Electric
  if (/\bev\b|electric|ioniq 6|ioniq 5|kia ev|niro ev|bolt ev|leaf|tesla/.test(combined)) {
    return "Electric";
  }
  // Hybrid
  if (/hybrid|plug.in|phev|prius|niro hybrid|rav4 hybrid|escape hybrid/.test(combined)) {
    return "Hybrid";
  }
  // Diesel
  if (/diesel|duramax|powerstroke|cummins/.test(combined)) {
    return "Diesel";
  }
  // Default — gasoline covers 95% of used car inventory
  return "Gasoline";
}

async function humanType(element, text) {
  element.focus();
  await sleep(300 + Math.random() * 300);

  // Clear existing value first
  element.select?.();
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);

  for (const char of text) {
    // Full keyboard event sequence per character
    const events = [
      new KeyboardEvent("keydown", { key: char, bubbles: true, cancelable: true }),
      new KeyboardEvent("keypress", { key: char, bubbles: true, cancelable: true }),
    ];
    events.forEach(e => element.dispatchEvent(e));

    // Insert character
    document.execCommand("insertText", false, char);

    element.dispatchEvent(new InputEvent("input", {
      data: char,
      inputType: "insertText",
      bubbles: true,
    }));
    element.dispatchEvent(new KeyboardEvent("keyup", {
      key: char, bubbles: true
    }));

    // Random delay between keystrokes (50-150ms)
    await sleep(50 + Math.random() * 100);

    // Occasional longer pause (simulates natural typing rhythm)
    if (Math.random() < 0.05) {
      await sleep(200 + Math.random() * 300);
    }
  }

  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new Event("blur", { bubbles: true }));

  // Pause after finishing a field
  await sleep(800 + Math.random() * 1200);
}

async function selectDropdownOption(text) {
  // Wait for dropdown to appear and click matching option
  await sleep(500);
  const options = document.querySelectorAll('[role="option"], [role="listitem"], li');
  for (const opt of options) {
    if (opt.innerText?.toLowerCase().includes(text.toLowerCase())) {
      opt.click();
      await sleep(500);
      return true;
    }
  }
  return false;
}

async function waitForElement(selector, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(500);
  }
  return null;
}

function showFbAutoFillBanner() {
  // Remove existing banner if any
  document.querySelector(".dealersorbit-fb-banner")?.remove();

  const banner = document.createElement("div");
  banner.className = "dealersorbit-fb-banner";
  banner.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #1877f2;
    color: white;
    padding: 16px 20px;
    border-radius: 8px;
    font-family: -apple-system, sans-serif;
    font-size: 14px;
    font-weight: 600;
    z-index: 999999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    max-width: 300px;
    line-height: 1.5;
  `;
  banner.innerHTML = `
  ✓ <strong>DealersOrbit filled your listing!</strong><br>
  <span style="font-weight:400;font-size:13px">
    ⏳ Wait 30 seconds for video to process, then review and click <strong>Next</strong>.
  </span>
    <div style="margin-top:8px">
      <button id="dealersorbit-confirm-post" style="
        background:white;color:#1877f2;border:none;
        padding:6px 12px;border-radius:4px;font-weight:700;
        cursor:pointer;font-size:12px;margin-right:8px
      ">I've Posted ✓</button>
      <button id="dealersorbit-dismiss" style="
        background:transparent;color:white;border:1px solid rgba(255,255,255,0.5);
        padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px
      ">Dismiss</button>
    </div>
  `;

  document.body.appendChild(banner);

  // "I've Posted" button — confirms posting and processes next queue item
  document.getElementById("dealersorbit-confirm-post")?.addEventListener("click", async () => {
    const { fb_listing } = await chrome.storage.local.get("fb_listing");

    if (fb_listing?.queue_item_id) {
      // Confirm posting in background queue
      chrome.runtime.sendMessage({
        type: "FB_POSTED_CONFIRM",
        listing_id: fb_listing.queue_item_id,
      });
    }

    // Mark listing as posted in backend + save listing_url
    chrome.runtime.sendMessage({
      type: "MARK_LISTING_POSTED",
      vehicle: fb_listing?.vehicle,
      listing_url: fb_listing?.vehicle?.listing_url,
    });

    banner.remove();
    const success = document.createElement("div");
    success.style.cssText = banner.style.cssText;
    success.style.background = "#16a34a";
    success.textContent = "✓ Posted! Next listing will open in 7-12 minutes.";
    document.body.appendChild(success);
    setTimeout(() => success.remove(), 4000);
  });

  document.getElementById("dealersorbit-dismiss")?.addEventListener("click", () => {
    banner.remove();
  });
}

function setNativeValue(element, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value"
  )?.set || Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value"
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────
async function init() {
  // Onboarding: detect if this is the detail page we're waiting for
  const { onboarding_waiting_detail, onboarding_detail_url } =
    await chrome.storage.local.get(['onboarding_waiting_detail', 'onboarding_detail_url']);

  if (onboarding_waiting_detail && onboarding_detail_url) {
    try {
      const stored  = new URL(onboarding_detail_url);
      const current = new URL(window.location.href);
      if (stored.hostname === current.hostname && stored.pathname === current.pathname) {
        console.log('DealersOrbit: Onboarding detail page detected');
        await chrome.storage.local.remove('onboarding_waiting_detail');
        chrome.runtime.sendMessage({ type: 'ONBOARDING_ON_DETAIL_PAGE' });
        await sleep(1500);
        startPhotoClickInterception();
      }
    } catch (_) {}
  }

  // Get config for this domain
  const config = await getDealershipConfig();

  if (!config) {
    // No config for this domain — don't inject anything
    return;
  }

  if (config.type === "cars_com") {
    if (!isVehiclePage()) return;

    // Cars.com VDPs always use /vehicledetail/ — use a direct check instead of the
    // generic isVdpPage() which falsely matches /shopping/new/, /shopping/certified-preowned/,
    // and /dealers/.../inventory/ via VDP_URL_PATTERNS (/new/, /certified/, /inventory/).
    if (window.location.pathname.toLowerCase().includes('/vehicledetail/')) {
      if (document.querySelector(`.${BUTTON_CLASS}`)) return;

      // Get all photos from thumbnail grid (all vehicle photos, not just 6 preview cards)
      const thumbImgs = Array.from(document.querySelectorAll('[part="thumbnail-grid"] button img'));
      const allPhotos = [...new Set(
        thumbImgs
          .map(img => (img.src || '').replace(/\?.*$/, ''))
          .filter(src => src && src.startsWith('http'))
      )];

      // Get structured vehicle data — try fuse-card data attribute, then generic page scrape
      const fuseCard = document.querySelector('fuse-card[data-vehicle-details]') ||
                       document.querySelector('fuse-card[data-listing-id]');
      let vehicleData = fuseCard ? scrapeCarsDotCom(fuseCard) : null;
      if (!vehicleData) vehicleData = scrapeVehicleFromPage();
      if (!vehicleData) return;

      // Thumbnail grid is authoritative for Cars.com — always prefer it over
      // scrapeVehicleFromPage which grabs every img including editorial junk
      if (allPhotos.length > 0) {
        vehicleData.photos = allPhotos.slice(0, 40);
      }
      vehicleData.listing_url = window.location.href;
      vehicleData.vdp_import  = true;

      const fixedBtn = createImportButton(vehicleData);
      fixedBtn.style.cssText += 'position:fixed;bottom:20px;right:20px;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
      document.body.appendChild(fixedBtn);

      // Also inject inline button near the listed price
      const priceAnchor = document.querySelector('h2.list-price') ||
                          document.querySelector('.price-location-stack__primary');
      if (priceAnchor) {
        const inlineBtn = createImportButton(vehicleData);
        inlineBtn.style.cssText += 'display:block;margin-top:12px;margin-bottom:8px;';
        priceAnchor.insertAdjacentElement('afterend', inlineBtn);
      }
      return;
    }

    const pageType = getPageType();
    if (pageType === "inventory") {
      // Optionally filter to only show buttons for the user's dealership
      const injectCarsDotCom = (cards) => {
        let filtered = cards;
        if (config._filter_dealer_name) {
          const filterLower = config._filter_dealer_name.toLowerCase();
          filtered = cards.filter(card => {
            const dealerEl = Array.from(card.querySelectorAll('.fuse-body-small'))
              .find(el => (el.getAttribute('style') || '').includes('text-weaker'));
            const cardDealer = dealerEl?.textContent?.trim().toLowerCase() || '';
            // No dealer label on this card type (e.g. dealer-specific page) — show button
            if (!cardDealer) return true;
            return cardDealer.includes(filterLower) ||
                   filterLower.includes(cardDealer.split(',')[0].trim());
          });
        }
        injectInventoryButtons(filtered);
      };

      const cards = findCarCards();
      if (cards.length > 0) {
        injectCarsDotCom(cards);
        const observer = new MutationObserver(() => injectCarsDotCom(findCarCards()));
        observer.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      injectSingleListingButton();
    }
    return;
  }

  if (config.type === "cargurus") {
    if (!isVehiclePage()) return;

    // CarGurus VDPs use /details/{numericId}
    if (window.location.hostname === 'www.cargurus.com' &&
        window.location.pathname.includes('/details/')) {
      if (document.querySelector(`.${BUTTON_CLASS}`)) return;

      // Collect photos from the rendered gallery
      const cgPhotos = [];
      const mainImg = document.querySelector('img[alt="Vehicle Full Photo"]');
      const mainSrc = mainImg?.src?.split('?')[0];
      if (mainSrc?.includes('cargurus.com')) cgPhotos.push(mainSrc);
      document.querySelectorAll('button[aria-label^="View vehicle photo"] img').forEach(img => {
        const src = img.src?.split('?')[0].replace('296x222', '1024x768');
        if (src?.includes('cargurus.com') && !cgPhotos.includes(src)) cgPhotos.push(src);
      });

      // Build vehicle data from VDP page (already rendered)
      const cgTitle = document.querySelector('h1[data-cg-ft="vdp-listing-title"]')?.innerText?.trim() ||
                      document.title || '';
      const cgPrice = document.querySelector('[class*="priceContainer"] h2')
                             ?.textContent?.match(/\$[\d,]+/)?.[0] || null;
      const cgVin   = (document.body.innerText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/) || [])[1] || null;
      const cgYear  = (cgTitle.match(/\b(19|20)\d{2}\b/) || [])[0] || null;
      const cgMake  = extractMake(cgTitle);

      const vehicleData = {
        vin:         cgVin,
        year:        cgYear,
        make:        cgMake,
        title:       cgTitle,
        price:       cgPrice,
        photos:      cgPhotos,
        listing_url: window.location.href,
        source_url:  window.location.href,
        scraped_at:  new Date().toISOString(),
        vdp_import:  true,
      };

      const fixedBtn = createImportButton(vehicleData);
      fixedBtn.style.cssText += 'position:fixed;bottom:20px;right:20px;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
      document.body.appendChild(fixedBtn);

      const priceAnchor = document.querySelector('[class*="priceContainer"]') ||
                          document.querySelector('h2');
      if (priceAnchor) {
        const inlineBtn = createImportButton(vehicleData);
        inlineBtn.style.cssText += 'display:block;margin-top:12px;margin-bottom:8px;';
        priceAnchor.insertAdjacentElement('afterend', inlineBtn);
      }
      return;
    }

    // Inventory pages (/search, /Cars/, /Cars/m-)
    const cards = findCarCards();
    if (cards.length > 0) {
      injectInventoryButtons(cards);
      const observer = new MutationObserver(() => injectInventoryButtons(findCarCards()));
      observer.observe(document.body, { childList: true, subtree: true });
    }
    return;
  }

  // Use dealership config
  const url = window.location.pathname;
  const cards = Array.from(
    document.querySelectorAll(config.inventory_page.card_selector)
  );
  // VDP check takes priority — VDPs often share URL prefixes with inventory (/used/)
  // so we check card count and VDP signals before falling back to url_patterns
  const hasMultipleCards = cards.length >= 2;
  const onVdp = !hasMultipleCards && isVdpPage();
  const isInventory = hasMultipleCards ||
    (!onVdp && config.inventory_page.url_patterns.some(p => url.includes(p)));

  function startInventoryMode(cfg) {
    const sel = cfg.inventory_page.card_selector;
    const existing = Array.from(document.querySelectorAll(sel));
    if (existing.length > 0) injectConfigDrivenButtons(existing, cfg);
    const observer = new MutationObserver(() => {
      injectConfigDrivenButtons(Array.from(document.querySelectorAll(sel)), cfg);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (isInventory) {
    startInventoryMode(config);
  } else if (onVdp) {
    injectVdpButton(config);
  } else {
    // Cards may not have loaded yet (JS-heavy new car pages) — retry after 3s
    setTimeout(() => {
      const lateCards = Array.from(
        document.querySelectorAll(config.inventory_page.card_selector)
      );
      if (lateCards.length >= 2) {
        startInventoryMode(config);
      } else if (isVdpPage()) {
        injectVdpButton(config);
      }
    }, 3000);
  }
}


// Run on page load
// Small delay lets the page finish rendering dynamic content
setTimeout(init, 1500);
setTimeout(tryFacebookAutoFill, 2000);

// FB Post flow — triggered when popup opens facebook.com?dealersorbit_post=1
if (window.location.href.includes("facebook.com") &&
    new URLSearchParams(window.location.search).get("dealersorbit_post") === "1") {
  setTimeout(tryFacebookPostFlow, 1000);
}

// FB Groups post flow — triggered when popup opens facebook.com/groups/feed/?dealersorbit_groups=1
if (window.location.href.includes("facebook.com") &&
    new URLSearchParams(window.location.search).get("dealersorbit_groups") === "1") {
  console.log('DealersOrbit: FB groups post mode detected');
  setTimeout(tryFacebookGroupsFlow, 4000);
}

// Also run when the URL changes (single-page apps)
let lastUrl = window.location.href;
new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    setTimeout(init, 1500);
  }
}).observe(document.body, { childList: true, subtree: true });

// ── Onboarding: message listener ─────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_CARD_DETECTION') {
    console.log('DealersOrbit: Card detection started');
    startCardClickInterception();
    sendResponse({ success: true });
    return true;
  }
  if (message.type === 'START_PHOTO_DETECTION') {
    console.log('DealersOrbit: Photo detection started');
    startPhotoClickInterception();
    sendResponse({ success: true });
    return true;
  }
});

// ── Onboarding: card click interception ──────────────────────
let cardInterceptionActive  = false;
let photoInterceptionActive = false;
let photoClickHandler       = null;
let onboardingState_cardSelector = null;

function startCardClickInterception() {
  if (cardInterceptionActive) return;
  cardInterceptionActive = true;

  const indicator = document.createElement('div');
  indicator.id = 'dealersorbit-watching';
  indicator.style.cssText = `
    position:fixed;bottom:20px;right:20px;
    background:#1a56db;color:white;
    padding:8px 14px;border-radius:20px;
    font-size:12px;font-family:-apple-system,sans-serif;font-weight:600;
    z-index:999999;box-shadow:0 2px 8px rgba(0,0,0,0.2);pointer-events:none;
  `;
  indicator.textContent = '🔍 DealersOrbit is watching — click any vehicle';
  document.body.appendChild(indicator);

  document.addEventListener('click', onCardClick, { capture: true });
}

async function onCardClick(e) {
  const link = e.target.closest('a[href]');
  if (!link) return;

  const href = link.getAttribute('href') || '';
  const isVehicleLink =
    href.includes('/used/') || href.includes('/inventory/') ||
    href.includes('/vehicle')  || href.includes('/vdp') ||
    href.includes('/car/')     || href.includes('/auto/') ||
    href.includes('/new/')     || href.includes('-for-sale');

  if (!isVehicleLink) return;

  const cardSelector = findRepeatingAncestor(link);
  if (cardSelector) {
    console.log('DealersOrbit: Found card selector:', cardSelector);
    onboardingState_cardSelector = cardSelector;
  }

  document.removeEventListener('click', onCardClick, { capture: true });
  document.getElementById('dealersorbit-watching')?.remove();
  cardInterceptionActive = false;

  chrome.runtime.sendMessage({
    type:         'CARD_CLICKED',
    cardSelector: cardSelector,
    detailUrl:    link.href,
  });
}

function findRepeatingAncestor(element) {
  let current = element;
  for (let i = 0; i < 8; i++) {
    current = current.parentElement;
    if (!current || current === document.body) break;

    const tag     = current.tagName.toLowerCase();
    const classes = Array.from(current.classList)
      .filter(c => c.length > 1 && !c.match(/^(active|hover|selected|first|last|open|show)$/i))
      .slice(0, 2)
      .join('.');

    if (!classes) continue;

    const selector = `${tag}.${classes}`;
    try {
      const matches = document.querySelectorAll(selector);
      if (matches.length >= 3) {
        const validCards = Array.from(matches).filter(el =>
          el.querySelector('img') && el.querySelector('a[href]')
        );
        if (validCards.length >= 3) return selector;
      }
    } catch (_) { continue; }
  }
  return null;
}

// ── Onboarding: photo click interception ─────────────────────
function startPhotoClickInterception() {
  if (photoInterceptionActive) return;
  photoInterceptionActive = true;

  let indicator = document.getElementById('dealersorbit-watching');
  if (indicator) {
    indicator.textContent = '📸 Click an exterior photo of the car';
  } else {
    indicator = document.createElement('div');
    indicator.id = 'dealersorbit-watching';
    indicator.style.cssText = `
      position:fixed;bottom:20px;right:20px;
      background:#1a56db;color:white;
      padding:8px 14px;border-radius:20px;
      font-size:12px;font-family:-apple-system,sans-serif;font-weight:600;
      z-index:999999;box-shadow:0 2px 8px rgba(0,0,0,0.2);pointer-events:none;
    `;
    indicator.textContent = '📸 Click an exterior photo of the car';
    document.body.appendChild(indicator);
  }

  let photoClickCount = 0;

  photoClickHandler = (e) => {
    const img = e.target.closest('img');
    if (!img) return;
    if (img.naturalWidth < 100 || img.naturalHeight < 100) return;

    const src      = img.getAttribute('data-src') || img.src || '';
    const selector = getImgSelector(img);

    photoClickCount++;

    if (photoClickCount === 1) {
      chrome.runtime.sendMessage({ type: 'PHOTO_CLICKED', photoType: 'exterior', src, selector });
      const ind = document.getElementById('dealersorbit-watching');
      if (ind) {
        ind.textContent = '✓ Exterior noted! Now click an interior photo (dashboard / seats)';
        ind.style.background = '#16a34a';
      }
    } else if (photoClickCount === 2) {
      chrome.runtime.sendMessage({ type: 'PHOTO_CLICKED', photoType: 'interior', src, selector });
      document.removeEventListener('click', photoClickHandler, { capture: true });
      document.getElementById('dealersorbit-watching')?.remove();
      photoInterceptionActive = false;
      chrome.runtime.sendMessage({ type: 'PHOTOS_DONE' });
    }
  };

  document.addEventListener('click', photoClickHandler, { capture: true });
}

function getImgSelector(img) {
  const parent = img.parentElement;
  if (!parent) return 'img';
  const parentTag     = parent.tagName.toLowerCase();
  const parentClasses = Array.from(parent.classList).slice(0, 2).join('.');
  return parentClasses ? `${parentTag}.${parentClasses} img` : 'img';
}