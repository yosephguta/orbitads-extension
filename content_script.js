/**
 * OrbitAds Content Script
 * ────────────────────────
 * Injected into vehicle listing pages by Chrome.
 * 
 * Responsibilities:
 *   1. Detect if this is a vehicle listing page
 *   2. Find car cards on inventory pages
 *   3. Inject "Import to OrbitAds" buttons
 *   4. Scrape vehicle data when button is clicked
 *   5. Send data to background.js for queue processing
 */

// ── Constants ─────────────────────────────────────────────────
const BUTTON_CLASS    = "orbitads-import-btn";
const INJECTED_ATTR   = "data-orbitads-injected";
const BRAND_COLOR     = "#1a56db";
const BRAND_COLOR_HOV = "#1e40af";

// VIN pattern — 17 alphanumeric characters (no I, O, Q)
const VIN_REGEX = /\b([A-HJ-NPR-Z0-9]{17})\b/;

// Price pattern — e.g. $19,995 or $19995
const PRICE_REGEX = /\$[\d,]+/;

// Year pattern — 4 digits starting with 19 or 20
const YEAR_REGEX = /\b(19|20)\d{2}\b/;

// Common car makes for detection
const CAR_MAKES = [
  "acura","alfa","audi","bmw","buick","cadillac","chevrolet","chevy",
  "chrysler","dodge","ferrari","fiat","ford","genesis","gmc","honda",
  "hyundai","infiniti","jaguar","jeep","kia","lamborghini","land rover",
  "lexus","lincoln","maserati","mazda","mercedes","mini","mitsubishi",
  "nissan","porsche","ram","rivian","rolls","subaru","tesla","toyota",
  "volkswagen","volvo","vw",
];


// ── Page detection ────────────────────────────────────────────
/**
 * Score this page to determine if it's a vehicle listing page.
 * Returns true if we're confident this is a vehicle page.
 */
function isVehiclePage() {
  const text = document.body.innerText.toLowerCase();
  let score  = 0;

  // URL signals
  const url = window.location.href.toLowerCase();
  const urlSignals = [
    "inventory","vehicle","listing","used","new-cars","certified",
    "for-sale","pre-owned","stock",
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
    '[class*="vehicle"]','[class*="listing"]','[class*="inventory"]',
    '[class*="car-card"]','[class*="vehicle-card"]','[class*="result-item"]',
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
    /\/vin\//,/\/vehicle\//,/\/listing\//,
    /[a-hj-npr-z0-9]{17}/i,   // VIN in URL
    /\/detail\//,/\/vdp\//,
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
    // Cars.com — uses fuse-card web components with JSON data
    'fuse-card[data-listing-id]',
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
  const text  = el.innerText || "";
  const html  = el.innerHTML || "";
  let score   = 0;

  if (PRICE_REGEX.test(text))  score += 2;
  if (YEAR_REGEX.test(text))   score += 1;
  if (VIN_REGEX.test(text))    score += 2;
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
function scrapeVehicleFromCard(card) {
    // Cars.com — use structured JSON data
    if (card.tagName.toLowerCase() === 'fuse-card') {
        const carsData = scrapeCarsDotCom(card);
        if (carsData) return carsData;
    }

    // Generic scraper for all other sites
    const text = card.innerText || "";
    return {
        vin:         extractVIN(text) || extractVIN(document.body.innerText),
        year:        extractYear(text),
        make:        extractMake(text),
        model:       extractModel(card),
        trim:        extractTrim(card),
        price:       extractPrice(text),
        mileage:     extractMileage(text),
        photos:      extractPhotosFromCard(card),
        listing_url: extractListingUrl(card),
        source_url:  window.location.href,
        scraped_at:  new Date().toISOString(),
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
        
        // Extract listing URL from the parent LI
        const li = card.closest('li');
        const link = li?.querySelector('a[href*="/vehicledetail/"]');
        const href = link?.getAttribute('href') || '';
        const listingUrl = href.startsWith('http') ? 
          href : 
          'https://www.cars.com' + href;
        return {
            vin:         data.vin || null,
            year:        data.year?.toString() || null,
            make:        data.make || null,
            model:       data.model || null,
            trim:        data.trim || null,
            price:       data.price ? '$' + data.price.toLocaleString() : null,
            mileage:     data.mileage ? data.mileage.toLocaleString() + ' mi' : null,
            photos:      extractPhotosFromCard(card),
            listing_url: listingUrl,
            source_url:  window.location.href,
            scraped_at:  new Date().toISOString(),
        };
    } catch (e) {
        return null;
    }
}

function scrapeVehicleFromPage() {
  const text = document.body.innerText || "";

  return {
    vin:         extractVIN(text),
    year:        extractYear(text),
    make:        extractMake(text),
    model:       extractModel(document.body),
    trim:        extractTrim(document.body),
    price:       extractPrice(text),
    mileage:     extractMileage(text),
    photos:      extractPhotosFromPage(),
    listing_url: window.location.href,
    source_url:  window.location.href,
    scraped_at:  new Date().toISOString(),
  };
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
  const imgs   = card.querySelectorAll("img");

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
    "thumb","icon","logo","badge","avatar","sprite",
    "placeholder","blank","pixel","tracking","dealer-logo",
    ".gif","data:image","1x1","spacer",
  ];
  if (skipPatterns.some(p => lower.includes(p))) return false;
  const validExts = [".jpg",".jpeg",".png",".webp"];
  const hasValidExt = validExts.some(e => lower.includes(e));
  const isKnownCDN  = [
    "cstatic-images","cargurus","autotrader","dealer.com",
    "dealerinspire","cloudfront","amazonaws","imgix",
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
 * Create the Import to OrbitAds button.
 */
function createImportButton(vehicleData) {
  const btn       = document.createElement("button");
  btn.className   = BUTTON_CLASS;
  btn.textContent = "⊕ Import to OrbitAds";
  btn.title       = "Add this vehicle to OrbitAds ad generation queue";

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Show loading state
    btn.textContent = "Adding to queue...";
    btn.disabled    = true;
    btn.style.background = "#6b7280";

    try {
      // Send to background script
      const response = await chrome.runtime.sendMessage({
        type:    "ADD_TO_QUEUE",
        vehicle: vehicleData,
      });

      if (response && response.success) {
        btn.textContent      = "✓ Added to queue!";
        btn.style.background = "#16a34a";
        setTimeout(() => {
          btn.textContent      = "✓ In Queue";
          btn.style.background = "#15803d";
        }, 2000);
      } else {
        throw new Error(response?.error || "Unknown error");
      }
    } catch (err) {
      btn.textContent      = "✕ Error — retry";
      btn.style.background = "#dc2626";
      btn.disabled         = false;
      console.error("OrbitAds import error:", err);
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
  const btn         = createImportButton(vehicleData);

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


// ── Main ──────────────────────────────────────────────────────
function init() {
  // First check: is this actually a vehicle page?
  if (!isVehiclePage()) return;

  const pageType = getPageType();

  if (pageType === "inventory") {
    const cards = findCarCards();
    if (cards.length > 0) {
      injectInventoryButtons(cards);

      // Watch for new cards loaded dynamically (infinite scroll / pagination)
      const observer = new MutationObserver(() => {
        const newCards = findCarCards();
        injectInventoryButtons(newCards);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  } else {
    injectSingleListingButton();
  }
}


// Run on page load
// Small delay lets the page finish rendering dynamic content
setTimeout(init, 1500);

// Also run when the URL changes (single-page apps)
let lastUrl = window.location.href;
new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    setTimeout(init, 1500);
  }
}).observe(document.body, { childList: true, subtree: true });