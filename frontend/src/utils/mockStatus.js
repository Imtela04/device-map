export function mockStatus(id) {
  const n = String(id).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return ['online','online','online','online','online','online','degraded','degraded','down','down'][n % 10];
}