/**
 * OrbitAds Dealership Scraper Configs
 * ─────────────────────────────────────
 * Each config defines how to scrape vehicle data from a specific
 * dealership website or website provider.
 *
 * Structure:
 *   PROVIDER_CONFIGS   — shared configs for website providers
 *   DEALERSHIP_CONFIGS — per-dealership overrides tied to specific domains
 *
 * When a user visits a page:
 *   1. Check DEALERSHIP_CONFIGS for their exact domain
 *   2. Fall back to PROVIDER_CONFIGS if domain matches a known provider
 *   3. Fall back to Cars.com parser if on cars.com
 *   4. Show "not supported" message otherwise
 *
 * photo_hints:
 *   exterior_position: "first" | "last" | "middle"
 *   exterior_count:    how many exterior photos to expect
 *   interior_position: "first" | "last" | "middle"
 *
 * Adding a new dealership:
 *   Add an entry to DEALERSHIP_CONFIGS with the domain and config.
 *   If the dealership uses a known provider, just set the provider
 *   and the selectors will work automatically.
 */


// ── Provider configs ──────────────────────────────────────────
export const PROVIDER_CONFIGS = {

  dealer_inspire: {
    name: "Dealer Inspire",
    // Default photo hints for Dealer Inspire sites
    // Most put exterior photos first — override per dealership if different
    photo_hints: {
      exterior_position: "first",
      exterior_count:    12,
      interior_position: "after_exterior",
    },
    inventory_page: {
      url_patterns: [
        "/inventory", "/new-inventory", "/used-inventory",
        "/certified-inventory", "/pre-owned",
      ],
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
      extractors: {
        vin:     { type: "attribute", selector: "[data-vin]", attribute: "data-vin" },
        title:   { type: "text",  selector: "h1, .vehicle-title" },
        price:   { type: "text",  selector: ".final-price.internetPrice.font-weight-bo" },
        mileage: { type: "text",  selector: ".highlight-badge", filter: "miles" },
        photos:  { type: "images", selector: ".slick-slide img, .carousel img, .gallery img",
                   strip_params: true },
      },
    },
  },

  dealer_socket: {
    name: "DealerSocket",
    photo_hints: {
      exterior_position: "first",
      exterior_count:    10,
    },
    inventory_page: {
      url_patterns: ["/inventory", "/vehicles", "/search"],
      card_selector: "[class*='vehicle-card'], [class*='inventory-item'], .ds-vehicle-card",
      extractors: {
        vin:     { type: "attribute", selector: "[data-vin], [data-vehicle-vin]", attribute: "data-vin" },
        title:   { type: "text",  selector: ".vehicle-title, h2, h3" },
        price:   { type: "text",  selector: "[class*='price']:not([class*='label'])" },
        mileage: { type: "text",  selector: "[class*='mileage'], [class*='miles']" },
        link:    { type: "href",  selector: "a[href*='vehicle'], a[href*='inventory']" },
        photos:  { type: "images", selector: "img", strip_params: true },
      },
    },
    detail_page: {
      url_patterns: ["/vehicle/", "/vdp/"],
      extractors: {
        vin:    { type: "text",   selector: "[class*='vin']" },
        title:  { type: "text",  selector: "h1" },
        price:  { type: "text",  selector: "[class*='price']:not([class*='label'])" },
        photos: { type: "images", selector: ".gallery img, [class*='photo'] img",
                  strip_params: true },
      },
    },
  },

  cdk_sincro: {
    name: "CDK/Sincro",
    photo_hints: {
      exterior_position: "first",
      exterior_count:    10,
    },
    inventory_page: {
      url_patterns: ["/inventory", "/new-vehicles", "/used-vehicles"],
      card_selector: ".vehicle-card, .inventory-listing-item, [class*='srp-card']",
      extractors: {
        vin:     { type: "attribute", selector: "[data-vin]", attribute: "data-vin" },
        title:   { type: "text",  selector: ".vehicle-card-title, h2, h3" },
        price:   { type: "text",  selector: ".price-block .price, .final-price" },
        mileage: { type: "text",  selector: "[class*='mileage']" },
        link:    { type: "href",  selector: "a.vehicle-card-link, a[href*='inventory']" },
        photos:  { type: "images", selector: "img", strip_params: true },
      },
    },
    detail_page: {
      url_patterns: ["/inventory/new/", "/inventory/used/"],
      extractors: {
        vin:    { type: "text",   selector: ".vin-value, [class*='vin']" },
        title:  { type: "text",  selector: "h1" },
        price:  { type: "text",  selector: ".final-price, .selling-price" },
        photos: { type: "images", selector: ".media-gallery img", strip_params: true },
      },
    },
  },

};


// ── Per-dealership configs ────────────────────────────────────
export const DEALERSHIP_CONFIGS = {

  "jbakia.com": {
    dealership_name: "JBA Kia",
    provider: "dealer_inspire",
    overrides: {},
    // JBA's unusual photo order:
    // 1 exterior first → many interior → 14 exterior at the end
    photo_hints: {
      exterior_position: "last",
      exterior_count:    14,
      interior_position: "middle",
    },
  },

  "www.jbakia.com": {
    dealership_name: "JBA Kia",
    provider: "dealer_inspire",
    overrides: {},
    photo_hints: {
      exterior_position: "last",
      exterior_count:    14,
      interior_position: "middle",
    },
  },

  // ── Template for adding new dealerships ───────────────────
  // "www.newdealership.com": {
  //   dealership_name: "New Dealership Name",
  //   provider: "dealer_inspire",
  //   overrides: {},
  //   photo_hints: {
  //     exterior_position: "first",  // "first" | "last" | "middle"
  //     exterior_count: 12,
  //     interior_position: "after_exterior",
  //   },
  // },

};


// ── Cars.com config (universal fallback) ──────────────────────
export const CARS_COM_CONFIG = {
  name: "Cars.com",
  domains: ["cars.com", "www.cars.com"],
  type: "cars_com",
  photo_hints: {
    exterior_position: "first",
    exterior_count:    10,
  },
};


// ── Config resolver ───────────────────────────────────────────
export function getConfigForDomain(domain) {
  const cleanDomain = domain.replace(/^www\./, "");
  const withWww     = "www." + cleanDomain;

  // Check exact domain match
  const dealerConfig = DEALERSHIP_CONFIGS[domain] ||
                       DEALERSHIP_CONFIGS[withWww] ||
                       DEALERSHIP_CONFIGS[cleanDomain];

  if (dealerConfig) {
    const providerConfig = PROVIDER_CONFIGS[dealerConfig.provider];
    if (!providerConfig) return null;

    return {
      dealership_name: dealerConfig.dealership_name,
      provider:        dealerConfig.provider,
      // Dealership photo hints override provider defaults
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

  if (domain.includes("cars.com")) return CARS_COM_CONFIG;

  return null;
}