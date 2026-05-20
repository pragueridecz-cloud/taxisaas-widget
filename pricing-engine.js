/**
 * TaxiSaaS Pricing Engine v1.0
 * Logika výpočtu cen pro widget
 * 
 * Priorita:
 * 1. Pevná místa (landmarks) — obě adresy musí být landmark
 * 2. Zóny (polygon > PSČ)
 * 3. Vzdálenostní ceník (stupňovaný tarif)
 * 4. Minimální cena
 * + Nástupní sazba vždy
 * + Příplatky
 * - Slevy / Vouchery
 */

(function() {

  // ============================================================
  // KONFIGURACE — načte se ze Supabase
  // ============================================================
  var NLL_CFG = {
    vehicles: [],
    landmarks: [],
    zone_matrix: {},
    pricing_zones: [],
    distance_rows: [],
    surcharges: {
      night:   { enabled: false, type: 'fixed', value: 0 },
      weekend: { enabled: false, type: 'fixed', value: 0 },
      holiday: { enabled: false, type: 'fixed', value: 0 },
      bike:    { enabled: true,  type: 'fixed', value: 200 },
      ski:     { enabled: true,  type: 'fixed', value: 100 },
    },
    discounts: [],
    min_price: 200,
  };

  // ============================================================
  // NAČTENÍ DAT ZE SUPABASE
  // ============================================================
  window.nllLoadPricingData = async function(sbUrl, sbKey) {
    try {
      // 1. Tenant settings
      var r1 = await fetch(sbUrl + '/rest/v1/tenant_settings?select=*&limit=1', {
        headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey }
      });
      var d1 = await r1.json();
      if (d1 && d1.length) {
        var cfg = d1[0];
        if (cfg.vehicles) NLL_CFG.vehicles = cfg.vehicles.filter(function(v){ return v.active; });
        if (cfg.min_price) NLL_CFG.min_price = cfg.min_price;
        if (cfg.pricing_zones) NLL_CFG.pricing_zones = cfg.pricing_zones;
        if (cfg.zone_matrix) NLL_CFG.zone_matrix = cfg.zone_matrix;
        if (cfg.discounts) NLL_CFG.discounts = cfg.discounts;

        // Příplatky
        NLL_CFG.surcharges = {
          night:   { enabled: cfg.surcharge_night_enabled   || false, type: cfg.surcharge_night_type   || 'fixed', value: cfg.surcharge_night   || 0 },
          weekend: { enabled: cfg.surcharge_weekend_enabled || false, type: cfg.surcharge_weekend_type || 'fixed', value: cfg.surcharge_weekend || 0 },
          holiday: { enabled: cfg.surcharge_holiday_enabled || false, type: cfg.surcharge_holiday_type || 'fixed', value: cfg.surcharge_holiday || 0 },
          bike:    { enabled: true, type: cfg.surcharge_bike_type || 'fixed', value: cfg.surcharge_bike || 200 },
          ski:     { enabled: true, type: cfg.surcharge_ski_type  || 'fixed', value: cfg.surcharge_ski  || 100 },
        };
      }

      // 2. Vzdálenostní ceník
      var r2 = await fetch(sbUrl + '/rest/v1/distance_pricing?select=*&order=km_from.asc', {
        headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey }
      });
      var d2 = await r2.json();
      if (d2 && d2.length) NLL_CFG.distance_rows = d2;

      // 3. Pevná místa (landmarks)
      var r3 = await fetch(sbUrl + '/rest/v1/landmarks?select=*&is_active=eq.true&order=sort_order.asc', {
        headers: { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey }
      });
      var d3 = await r3.json();
      if (d3 && d3.length) NLL_CFG.landmarks = d3;

      console.log('[TaxiSaaS] Pricing data loaded:', {
        vehicles: NLL_CFG.vehicles.length,
        landmarks: NLL_CFG.landmarks.length,
        distance_rows: NLL_CFG.distance_rows.length,
        zones: NLL_CFG.pricing_zones.length,
      });

    } catch(e) {
      console.warn('[TaxiSaaS] Pricing data load error:', e);
    }
  };

  // ============================================================
  // DETEKCE LANDMARKS
  // ============================================================
  function findLandmark(address) {
    if (!address || !NLL_CFG.landmarks.length) return null;
    var addr = address.toLowerCase().trim();
    for (var i = 0; i < NLL_CFG.landmarks.length; i++) {
      var lm = NLL_CFG.landmarks[i];
      if (addr.indexOf(lm.name.toLowerCase()) >= 0 || 
          (lm.address && addr.indexOf(lm.address.toLowerCase()) >= 0)) {
        return lm;
      }
    }
    return null;
  }

  // ============================================================
  // DETEKCE ZÓN (PSČ)
  // ============================================================
  function findZoneByPostal(address) {
    if (!address || !NLL_CFG.pricing_zones.length) return null;
    var postalMatch = address.match(/\b(\d{3}\s?\d{2})\b/);
    if (!postalMatch) return null;
    var postal = postalMatch[1].replace(/\s/g, '');
    for (var i = 0; i < NLL_CFG.pricing_zones.length; i++) {
      var zone = NLL_CFG.pricing_zones[i];
      if (!zone.postal_codes) continue;
      var codes = zone.postal_codes.split(',').map(function(c){ return c.trim().replace(/\s/g,''); });
      if (codes.indexOf(postal) >= 0) return zone;
    }
    return null;
  }

  // ============================================================
  // VÝPOČET CENY ZE ZÓNOVÉ MATICE
  // ============================================================
  function calcZonePrice(zoneFromId, zoneToId, vehicleId) {
    var matrix = NLL_CFG.zone_matrix;
    if (!matrix || !matrix[zoneFromId] || matrix[zoneFromId][zoneToId] === undefined) return null;
    var basePrice = matrix[zoneFromId][zoneToId];
    if (basePrice === 0) return null;
    return basePrice;
  }

  // ============================================================
  // VÝPOČET STUPŇOVANÉHO TARIFU
  // Každé pásmo: platíš cena_za_km × km v pásmu
  // + nástupní sazba vozidla
  // ============================================================
  function calcDistancePrice(km, vehicleId, vehicle) {
    var rows = NLL_CFG.distance_rows;
    if (!rows || !rows.length) return null;

    // Nástupní sazba
    var total = vehicle.price || 0;
    var remaining = km;

    // Seřaď pásma
    var sorted = rows.slice().sort(function(a, b){ return a.km_from - b.km_from; });

    for (var i = 0; i < sorted.length; i++) {
      if (remaining <= 0) break;
      var row = sorted[i];
      var pricePerKm = (row.prices && row.prices[vehicleId]) ? row.prices[vehicleId] : 0;
      if (pricePerKm === 0) continue;
      
      var bandSize = row.km_to - row.km_from;
      var kmInBand = Math.min(remaining, bandSize);
      total += kmInBand * pricePerKm;
      remaining -= kmInBand;
    }

    // Pokud zbývají km mimo všechna pásma — použij sazbu posledního pásma
    if (remaining > 0) {
      var lastRow = sorted[sorted.length - 1];
      var lastRate = (lastRow.prices && lastRow.prices[vehicleId]) ? lastRow.prices[vehicleId] : 0;
      total += remaining * lastRate;
    }

    return total;
  }

  // ============================================================
  // VÝPOČET PŘÍPLATKŮ
  // ============================================================
  function calcSurcharges(basePrice, date, extras) {
    var surcharges = NLL_CFG.surcharges;
    var total = 0;

    // Noční příplatek (22:00 - 06:00)
    if (surcharges.night && surcharges.night.enabled && extras.hour !== undefined) {
      var h = parseInt(extras.hour);
      if (h >= 22 || h < 6) {
        total += applySurcharge(surcharges.night, basePrice);
      }
    }

    // Víkendový příplatek
    if (surcharges.weekend && surcharges.weekend.enabled && date) {
      var d = new Date(date);
      var dow = d.getDay();
      if (dow === 0 || dow === 6) {
        total += applySurcharge(surcharges.weekend, basePrice);
      }
    }

    // Sváteční příplatek (TODO: seznam státních svátků)
    if (surcharges.holiday && surcharges.holiday.enabled && extras.isHoliday) {
      total += applySurcharge(surcharges.holiday, basePrice);
    }

    // Kola
    if (extras.bikes && extras.bikes > 0) {
      total += applySurcharge(surcharges.bike, basePrice) * extras.bikes;
    }

    // Lyže
    if (extras.skis && extras.skis > 0) {
      total += applySurcharge(surcharges.ski, basePrice) * extras.skis;
    }

    return Math.round(total);
  }

  function applySurcharge(surcharge, basePrice) {
    if (surcharge.type === 'percent') {
      return Math.round(basePrice * surcharge.value / 100);
    }
    return surcharge.value || 0;
  }

  // ============================================================
  // VÝPOČET SLEV
  // ============================================================
  function calcDiscounts(price, basePrice, activeDiscountIds) {
    if (!activeDiscountIds || !activeDiscountIds.length) return 0;
    var total = 0;
    NLL_CFG.discounts.forEach(function(d) {
      if (!d.enabled) return;
      if (activeDiscountIds.indexOf(d.id) < 0) return;
      var applyOn = d.applies_to === 'base' ? basePrice : price;
      if (d.type === 'percent') {
        total += Math.round(applyOn * d.value / 100);
      } else {
        total += d.value;
      }
    });
    return Math.min(total, price); // sleva nesmí přesáhnout cenu
  }

  // ============================================================
  // HLAVNÍ FUNKCE VÝPOČTU CENY
  // ============================================================
  window.nllCalculatePrice = async function(params) {
    /*
     * params: {
     *   pickup:    string,   // adresa vyzvednutí
     *   dropoff:   string,   // adresa cíle
     *   vehicleId: string,   // ID vozidla
     *   km:        number,   // vzdálenost z Google Maps (null = počkej)
     *   date:      string,   // datum YYYY-MM-DD
     *   hour:      number,   // hodina odjezdu
     *   isReturn:  bool,     // tam a zpět
     *   extras: {
     *     bikes: number,
     *     skis:  number,
     *     isHoliday: bool,
     *   },
     *   voucherDisc: number, // sleva z voucheru v Kč
     * }
     */

    var vehicle = NLL_CFG.vehicles.find(function(v){ return v.id === params.vehicleId; });
    if (!vehicle) return null;

    var basePrice = null;
    var pricingMethod = 'unknown';

    // ── 1. PEVNÁ MÍSTA ──────────────────────────────────────
    var puLandmark = findLandmark(params.pickup);
    var doLandmark = findLandmark(params.dropoff);

    if (puLandmark && doLandmark) {
      // Obě adresy jsou landmarks → hledej v zónové matici
      var puZoneId = puLandmark.zone_id || puLandmark.id;
      var doZoneId = doLandmark.zone_id || doLandmark.id;
      var zonePrice = calcZonePrice(puZoneId, doZoneId, params.vehicleId);
      if (zonePrice !== null) {
        basePrice = zonePrice;
        pricingMethod = 'landmark';
      }
    }

    // ── 2. ZÓNY (PSČ) ────────────────────────────────────────
    if (basePrice === null) {
      var puZone = findZoneByPostal(params.pickup);
      var doZone = findZoneByPostal(params.dropoff);
      if (puZone && doZone) {
        var zonePrice2 = calcZonePrice(puZone.id, doZone.id, params.vehicleId);
        if (zonePrice2 !== null) {
          basePrice = zonePrice2;
          pricingMethod = 'zone';
        }
      }
    }

    // ── 3. VZDÁLENOSTNÍ CENÍK ────────────────────────────────
    if (basePrice === null && params.km && params.km > 0) {
      var distPrice = calcDistancePrice(params.km, params.vehicleId, vehicle);
      if (distPrice !== null) {
        basePrice = distPrice;
        pricingMethod = 'distance';
      }
    }

    // Fallback — nástupní sazba
    if (basePrice === null) {
      basePrice = vehicle.price || 0;
      pricingMethod = 'base';
    }

    // ── ZPÁTEČNÍ JÍZDA ────────────────────────────────────────
    if (params.isReturn) {
      basePrice = basePrice * 2;
    }

    // ── PŘÍPLATKY ─────────────────────────────────────────────
    var surchargeTotal = calcSurcharges(basePrice, params.date, {
      hour: params.hour,
      bikes: params.extras ? params.extras.bikes : 0,
      skis:  params.extras ? params.extras.skis  : 0,
      isHoliday: params.extras ? params.extras.isHoliday : false,
    });

    var priceWithSurcharges = basePrice + surchargeTotal;

    // ── SLEVY ─────────────────────────────────────────────────
    var discountTotal = 0;
    if (params.activeDiscountIds) {
      discountTotal += calcDiscounts(priceWithSurcharges, basePrice, params.activeDiscountIds);
    }
    // Voucher sleva
    if (params.voucherDisc) {
      discountTotal += params.voucherDisc;
    }

    var finalPrice = Math.max(
      priceWithSurcharges - discountTotal,
      vehicle.min_price || NLL_CFG.min_price || 0
    );

    return {
      base: basePrice,
      surcharges: surchargeTotal,
      discounts: discountTotal,
      total: Math.round(finalPrice),
      method: pricingMethod,
      vehicle: vehicle,
    };
  };

  // ============================================================
  // GOOGLE MAPS DISTANCE
  // ============================================================
  window.nllGetDistance = function(pickup, dropoff, apiKey, callback) {
    if (!window.google || !window.google.maps) {
      callback(null);
      return;
    }
    var service = new google.maps.DistanceMatrixService();
    service.getDistanceMatrix({
      origins: [pickup],
      destinations: [dropoff],
      travelMode: google.maps.TravelMode.DRIVING,
      unitSystem: google.maps.UnitSystem.METRIC,
    }, function(response, status) {
      if (status !== 'OK') { callback(null); return; }
      try {
        var element = response.rows[0].elements[0];
        if (element.status !== 'OK') { callback(null); return; }
        var km = element.distance.value / 1000;
        var duration = element.duration.text;
        callback({ km: km, duration: duration, distanceText: element.distance.text });
      } catch(e) {
        callback(null);
      }
    });
  };

  // ============================================================
  // EXPORT
  // ============================================================
  window.NLL_CFG = NLL_CFG;
  window.nllFindLandmark = findLandmark;
  window.nllFindZone = findZoneByPostal;

  console.log('[TaxiSaaS] Pricing Engine v1.0 loaded');

})();
