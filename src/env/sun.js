// Solar position (NOAA approximation). Returns elevation/azimuth in radians and a
// direction vector in the local frame (x east, y up, z south).
export function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lon) * rad;
  const ha = lst - ra;
  const phi = lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha)); // from north, clockwise
  const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
  return { el, az, dir };
}

// Moon: rough position (good enough for brightness at night).
export function moonPhase(date) {
  const lp = 2551443;
  const newMoon = new Date(1970, 0, 7, 20, 35, 0).getTime() / 1000;
  const phase = ((date.getTime() / 1000 - newMoon) % lp) / lp;
  return 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI); // illuminated fraction
}

// Build a Date for a given local wall-clock time in a UTC offset (Brazil: -3, no DST).
export function localDate(y, mo, d, h, mi, tz) {
  return new Date(Date.UTC(y, mo - 1, d, h - tz, mi));
}
