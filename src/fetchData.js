function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86400000);
}

function interpolateYear(yearData) {
  const known = {};
  Object.entries(yearData).forEach(([d, v]) => { known[+d] = v; });
  const sorted = Object.keys(known).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return {};
  const out = {};
  for (let day = sorted[0]; day <= sorted[sorted.length - 1]; day++) {
    if (known[day] !== undefined) { out[day] = known[day]; continue; }
    let lo = day - 1, hi = day + 1;
    while (lo >= sorted[0] && known[lo] === undefined) lo--;
    while (hi <= sorted[sorted.length - 1] && known[hi] === undefined) hi++;
    if (known[lo] !== undefined && known[hi] !== undefined) {
      out[day] = known[lo] + (known[hi] - known[lo]) * (day - lo) / (hi - lo);
    }
  }
  return out;
}

function computeAvg(groupData, yearKeys) {
  const interpolated = yearKeys
    .filter(yr => groupData[yr] && Object.keys(groupData[yr]).length > 0)
    .map(yr => interpolateYear(groupData[yr]));
  const avg = {};
  for (let day = 1; day <= 366; day++) {
    const vals = interpolated.map(d => d[day]).filter(v => v != null && v > 0);
    if (vals.length > 0) {
      const logSum = vals.reduce((sum, v) => sum + Math.log(v), 0);
      avg[String(day)] = parseFloat(Math.exp(logSum / vals.length).toFixed(2));
    }
  }
  return avg;
}

function computeFngAvg(fngGroup, yearKeys) {
  const avg = {};
  for (let day = 1; day <= 366; day++) {
    const vals = yearKeys
      .map(yr => fngGroup[yr]?.[String(day)])
      .filter(v => v != null);
    if (vals.length > 0) {
      avg[String(day)] = parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1));
    }
  }
  return avg;
}

export async function fetchLiveData(currentRaw, currentFng, groups) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const todayDOY = dayOfYear(now);

  // Find which group the current year belongs to
  const group = groups.find(g => g.years.includes(String(currentYear)));
  if (!group) return { raw: currentRaw, fng: currentFng, lastDay: null };

  const yearStr = String(currentYear);
  const groupKey = group.key;

  // Check if data needs updating
  const existingData = currentRaw[groupKey]?.[yearStr] || {};
  const existingDays = Object.keys(existingData).map(Number);
  const lastExistingDay = existingDays.length ? Math.max(...existingDays) : 0;

  if (lastExistingDay >= todayDOY - 1) {
    return { raw: currentRaw, fng: currentFng, lastDay: lastExistingDay };
  }

  let newRaw = currentRaw;
  let newFng = currentFng;
  let lastDay = lastExistingDay;

  // Fetch BTC prices and F&G in parallel
  const jan1Ms = Date.UTC(currentYear, 0, 1);
  const [btcRes, fngRes] = await Promise.all([
    fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${jan1Ms}&limit=366`)
      .catch(() => null),
    fetch(`https://api.alternative.me/fng/?limit=${todayDOY + 5}&date_format=world`)
      .catch(() => null),
  ]);

  // Process BTC prices
  if (btcRes?.ok) {
    try {
      const klines = await btcRes.json();
      if (klines.length > 0) {
        const basePrice = parseFloat(klines[0][4]);
        const yearData = {};
        for (const k of klines) {
          const date = new Date(k[0]);
          if (date.getUTCFullYear() !== currentYear) continue;
          const doy = dayOfYear(date);
          const close = parseFloat(k[4]);
          yearData[String(doy)] = parseFloat(((close / basePrice) * 100).toFixed(2));
        }
        if (Object.keys(yearData).length > 0) {
          lastDay = Math.max(...Object.keys(yearData).map(Number));
          newRaw = JSON.parse(JSON.stringify(currentRaw));
          newRaw[groupKey][yearStr] = yearData;
          newRaw[groupKey].AVG = computeAvg(newRaw[groupKey], group.years);
        }
      }
    } catch (e) { /* keep existing */ }
  }

  // Process Fear & Greed
  if (fngRes?.ok) {
    try {
      const fngData = await fngRes.json();
      if (fngData.data?.length) {
        const yearFng = {};
        for (const entry of fngData.data) {
          const parts = entry.timestamp.split("-");
          const date = new Date(Date.UTC(+parts[2], +parts[1] - 1, +parts[0]));
          if (date.getUTCFullYear() !== currentYear) continue;
          const doy = dayOfYear(date);
          yearFng[String(doy)] = parseInt(entry.value);
        }
        if (Object.keys(yearFng).length > 0) {
          newFng = JSON.parse(JSON.stringify(currentFng));
          newFng[groupKey][yearStr] = yearFng;
          newFng[groupKey].AVG = computeFngAvg(newFng[groupKey], group.years.filter(yr => newFng[groupKey][yr]));
        }
      }
    } catch (e) { /* keep existing */ }
  }

  return { raw: newRaw, fng: newFng, lastDay };
}
