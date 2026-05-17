
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
const BUTTON_CLASS = "orbitads-import-btn";
const INJECTED_ATTR = "data-orbitads-injected";
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
function scrapeVehicleFromCard(card) {
  // Cars.com — use structured JSON data
  if (card.tagName.toLowerCase() === 'fuse-card') {
    const carsData = scrapeCarsDotCom(card);
    if (carsData) return carsData;
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

    // Extract listing URL from the parent LI
    const li = card.closest('li');
    const link = li?.querySelector('a[href*="/vehicledetail/"]');
    const href = link?.getAttribute('href') || '';
    const listingUrl = href.startsWith('http') ?
      href :
      'https://www.cars.com' + href;
    return {
      vin: data.vin || null,
      year: data.year?.toString() || null,
      make: data.make || null,
      model: data.model || null,
      trim: data.trim || null,
      price: data.price ? '$' + data.price.toLocaleString() : null,
      mileage: data.mileage ? data.mileage.toLocaleString() + ' mi' : null,
      photos: extractPhotosFromCard(card),
      listing_url: listingUrl,
      source_url: window.location.href,
      scraped_at: new Date().toISOString(),
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

  // Get link
  const linkEl = card.querySelector(ext.link.selector);
  const href = linkEl?.getAttribute('href') || '';
  const listingUrl = href.startsWith('http') ? href :
    window.location.origin + href;

  return {
    vin: getAttr(ext.vin.selector, ext.vin.attribute),
    year: extractYear(getText(ext.title.selector) || ''),
    make: extractMake(getText(ext.title.selector) || ''),
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
    if (!vehicleData.vin && !vehicleData.price) return;
    const btn = createImportButton(vehicleData);
    card.setAttribute(INJECTED_ATTR, "true");
    const footer = card.querySelector('[class*="footer"],[class*="actions"],[class*="price"]');
    if (footer) footer.appendChild(btn);
    else card.appendChild(btn);
  });
}

function injectConfigDrivenSingleButton(config) {
  if (document.querySelector(`.${BUTTON_CLASS}`)) return;
  const ext = config.detail_page.extractors;
  const getText = (sel) => document.querySelector(sel)?.innerText?.trim() || null;
  const photoEls = Array.from(document.querySelectorAll(ext.photos.selector));
  const photos = [...new Set(
    photoEls
      .map(img => (img.src || img.dataset.src || '').replace(/\?.*$/, ''))
      .filter(src => src && src.startsWith('http'))
  )].slice(0, 8);

  const vehicleData = {
    vin: document.querySelector(ext.vin.selector)
      ?.getAttribute(ext.vin.attribute) ||
      getText(ext.vin.selector),
    price: getText(ext.price.selector),
    photos: photos,
    listing_url: window.location.href,
    source_url: window.location.href,
    dealership: config.dealership_name,
    scraped_at: new Date().toISOString(),
  };

  const btn = createImportButton(vehicleData);
  const target = document.querySelector('h1') || document.querySelector('main');
  if (target) target.insertAdjacentElement('afterend', btn);
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
 * Create the Import to OrbitAds button.
 */
function createImportButton(vehicleData) {
  const btn = document.createElement("button");
  btn.className = BUTTON_CLASS;
  btn.textContent = "⊕ Import to OrbitAds";
  btn.title = "Add this vehicle to OrbitAds ad generation queue";

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;

    btn.disabled = true;
    btn.textContent = "Adding to queue...";
    btn.style.background = "#6b7280";

    // Set a timeout to re-enable button if message fails
    const timeout = setTimeout(() => {
      btn.disabled = false;
      btn.textContent = "⊕ Import to OrbitAds";
      btn.style.background = "";
      console.log("OrbitAds: Import timed out — re-enabling button");
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
      } else {
        btn.disabled = false;
        btn.textContent = "⊕ Import to OrbitAds";
        btn.style.background = "";
      }
    } catch (err) {
      clearTimeout(timeout);
      console.error("OrbitAds: Failed to send message:", err);
      btn.disabled = false;
      btn.textContent = "⊕ Import to OrbitAds";
      btn.style.background = "";
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

async function tryFacebookAutoFill() {
  const url = window.location.href;
  if (!url.includes("facebook.com/marketplace/create")) return;

  const { fb_listing } = await chrome.storage.local.get("fb_listing");
  if (!fb_listing) return;

  const age = Date.now() - new Date(fb_listing.created_at).getTime();
  if (age > 600000) return;

  console.log("OrbitAds: Waiting for Facebook form to load...");
  await waitForElement('[aria-label="Location"]', 15000);
  await sleep(3000);

  const v = fb_listing.vehicle;
  console.log("OrbitAds: Starting form fill...", v);

  // ── Step 1: Upload photos ─────────────────────────────────
  await uploadPhotosToFacebook(fb_listing);
  await sleep(2000);

  // ── Step 1b: Upload video ─────────────────────────────────
  await uploadVideoToFacebook(fb_listing);
  await sleep(2000);

  // ── Step 2: Year ──────────────────────────────────────────
  if (v.year) {
    await fillDropdown("Year", v.year);
    await sleep(1500);
  }

  // ── Step 3: Vehicle type (MUST come before Make/Model) ────
  await fillDropdown("Vehicle type", "Car/Truck");
  await sleep(2000); // wait for Make/Model fields to appear

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
      console.log(`OrbitAds: Make options found: ${options.length}`);

      const match = options.find(el =>
        el.innerText?.trim().toLowerCase() === makeFormatted.toLowerCase()
      );

      if (match) {
        match.click();
        console.log(`OrbitAds: ✓ Make → ${makeFormatted}`);
        await sleep(2500); // wait for Model field to appear
      } else {
        console.log(`OrbitAds: ✗ Make "${makeFormatted}" not found in options`);
        document.body.click();
        await sleep(500);
      }
    } else {
      console.log("OrbitAds: ✗ Make combobox not found");
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

      console.log(`OrbitAds: ✓ Model → ${v.model}`);
      await sleep(500);
    } else {
      console.log("OrbitAds: ✗ Model input not found");
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
  await fillDropdown("Body style", guessBodyStyle(v.model || ""));
  await sleep(1000);

  // ── Step 9: Vehicle condition ─────────────────────────────
  await fillDropdown("Vehicle condition", "Excellent");
  await sleep(1000);

  // ── Step 10: Fuel type ────────────────────────────────────
  await fillDropdown("Fuel type", guessFuelType(v.make || "", v.model || ""));
  await sleep(1000);

  // ── Step 11: Clean title checkbox ────────────────────────
  const cleanTitleCheckbox = document.querySelector(
    'input[type="checkbox"][name="title_status"], ' +
    'input[aria-label="This vehicle has a clean title."]'
  );
  if (cleanTitleCheckbox && cleanTitleCheckbox.getAttribute('aria-checked') !== 'true') {
    cleanTitleCheckbox.click();
    console.log("OrbitAds: ✓ Clean title checked");
    await sleep(500);
  }

  // ── Step 12: Description ──────────────────────────────────
  await sleep(1000);
  const textarea = document.querySelector('textarea');
  if (textarea && fb_listing.description) {
    textarea.focus();
    await sleep(500);
    await humanType(textarea, fb_listing.description);
  }

  showFbAutoFillBanner();
  console.log("OrbitAds: Form fill complete.");
}

// ── Exterior/Interior color ────────────────────────────────
// TODO: Extract color from VIN decode or add color picker to review screen
// Skipping for now — user can select manually


async function fillDropdown(labelText, optionText) {
  const comboboxes = Array.from(document.querySelectorAll('[role="combobox"]'));
  console.log(`OrbitAds: Looking for "${labelText}" among ${comboboxes.length} comboboxes:`,
    comboboxes.map(el => el.innerText?.trim().slice(0, 20)));

  const trigger = comboboxes.find(el =>
    el.innerText?.trim().toLowerCase().startsWith(labelText.toLowerCase())
  );
  // ... rest unchanged

  if (!trigger) {
    console.log(`OrbitAds: Dropdown "${labelText}" not found`);
    return false;
  }

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
        console.log(`OrbitAds: ✓ "${labelText}" → "${match.innerText?.trim()}"`);
        await sleep(500);
        return true;
      }
    }

    await sleep(800); // wait and try again
  }

  // Close dropdown
  document.body.click();
  await sleep(300);
  console.log(`OrbitAds: ✗ No match for "${optionText}" in "${labelText}" dropdown`);
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
    console.log("OrbitAds: Photo file input not found");
    return;
  }

  console.log(`OrbitAds: Downloading ${Math.min(photoUrls.length, 20)} photos...`);

  try {
    // Download photos and convert to File objects
    const files = [];
    for (const url of photoUrls.slice(0, 20)) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const filename = url.split('/').pop() || 'photo.jpg';
        const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
        files.push(file);
        await sleep(100);
      } catch (e) {
        console.log(`OrbitAds: Failed to download photo: ${url}`);
      }
    }

    if (!files.length) return;

    // Create DataTransfer and add files
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    fileInput.files = dt.files;

    // Trigger change event so React picks it up
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));

    console.log(`OrbitAds: Uploaded ${files.length} photos`);
    await sleep(2000);

  } catch (err) {
    console.error("OrbitAds: Photo upload failed:", err);
  }
}

async function uploadVideoToFacebook(fbListing) {
  if (!fbListing.video_url) {
    console.log("OrbitAds: No video URL — skipping video upload");
    return;
  }

  const videoInput = document.querySelector(
    'input[type="file"][accept*="video"]'
  );

  if (!videoInput) {
    console.log("OrbitAds: Video file input not found");
    return;
  }

  console.log("OrbitAds: Downloading video for Facebook upload...");

  try {
    const resp = await fetch(fbListing.video_url);
    if (!resp.ok) {
      console.log("OrbitAds: Video download failed:", resp.status);
      return;
    }

    const blob = await resp.blob();
    const file = new File([blob], "vehicle-ad.mp4", { type: "video/mp4" });

    const dt = new DataTransfer();
    dt.items.add(file);
    videoInput.files = dt.files;

    videoInput.dispatchEvent(new Event("change", { bubbles: true }));
    videoInput.dispatchEvent(new Event("input", { bubbles: true }));

    console.log("OrbitAds: ✓ Video uploaded to Facebook");
    await sleep(4000); // Facebook needs time to process video

  } catch (err) {
    console.error("OrbitAds: Video upload failed:", err);
  }
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
  document.querySelector(".orbitads-fb-banner")?.remove();

  const banner = document.createElement("div");
  banner.className = "orbitads-fb-banner";
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
    ✓ <strong>OrbitAds filled your listing!</strong><br>
    <span style="font-weight:400;font-size:13px">
      Review the details and click <strong>Next</strong> or <strong>Publish</strong> when ready.
    </span>
    <div style="margin-top:8px">
      <button id="orbitads-confirm-post" style="
        background:white;color:#1877f2;border:none;
        padding:6px 12px;border-radius:4px;font-weight:700;
        cursor:pointer;font-size:12px;margin-right:8px
      ">I've Posted ✓</button>
      <button id="orbitads-dismiss" style="
        background:transparent;color:white;border:1px solid rgba(255,255,255,0.5);
        padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px
      ">Dismiss</button>
    </div>
  `;

  document.body.appendChild(banner);

  // "I've Posted" button — confirms posting and processes next queue item
  document.getElementById("orbitads-confirm-post")?.addEventListener("click", async () => {
    const { fb_listing } = await chrome.storage.local.get("fb_listing");
    if (fb_listing?.queue_item_id) {
      chrome.runtime.sendMessage({
        type: "FB_POSTED_CONFIRM",
        listing_id: fb_listing.queue_item_id,
      });
    }
    banner.remove();
    // Show success message
    const success = document.createElement("div");
    success.style.cssText = banner.style.cssText;
    success.style.background = "#16a34a";
    success.textContent = "✓ Posted! Next listing will open in 7-12 minutes.";
    document.body.appendChild(success);
    setTimeout(() => success.remove(), 4000);
  });

  document.getElementById("orbitads-dismiss")?.addEventListener("click", () => {
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

function showFbAutoFillBanner() {
  const banner = document.createElement("div");
  banner.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #1877f2;
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-family: -apple-system, sans-serif;
    font-size: 14px;
    font-weight: 600;
    z-index: 999999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  banner.textContent = "✓ OrbitAds: Listing details filled in!";
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 4000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ──────────────────────────────────────────────────────
async function init() {
  // Get config for this domain
  const config = await getDealershipConfig();

  if (!config) {
    // No config for this domain — don't inject anything
    return;
  }

  if (config.type === "cars_com") {
    // Use Cars.com specific parser
    if (!isVehiclePage()) return;
    const pageType = getPageType();
    if (pageType === "inventory") {
      const cards = findCarCards();
      if (cards.length > 0) {
        injectInventoryButtons(cards);
        const observer = new MutationObserver(() => {
          injectInventoryButtons(findCarCards());
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    } else {
      injectSingleListingButton();
    }
    return;
  }

  // Use dealership config
  const url = window.location.pathname;
  const isInventory = config.inventory_page.url_patterns
    .some(p => url.includes(p));

  if (isInventory) {
    const cards = Array.from(
      document.querySelectorAll(config.inventory_page.card_selector)
    );
    if (cards.length > 0) {
      injectConfigDrivenButtons(cards, config);
      const observer = new MutationObserver(() => {
        const newCards = Array.from(
          document.querySelectorAll(config.inventory_page.card_selector)
        );
        injectConfigDrivenButtons(newCards, config);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  } else {
    injectConfigDrivenSingleButton(config);
  }
}


// Run on page load
// Small delay lets the page finish rendering dynamic content
setTimeout(init, 1500);
setTimeout(tryFacebookAutoFill, 2000)

// Also run when the URL changes (single-page apps)
let lastUrl = window.location.href;
new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    setTimeout(init, 1500);
  }
}).observe(document.body, { childList: true, subtree: true });