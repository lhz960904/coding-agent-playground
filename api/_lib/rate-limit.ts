const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(ip: string, limitPerDay: number): { ok: boolean; remaining: number } {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const bucket = buckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + ONE_DAY });
    return { ok: true, remaining: limitPerDay - 1 };
  }
  if (bucket.count >= limitPerDay) {
    return { ok: false, remaining: 0 };
  }
  bucket.count += 1;
  return { ok: true, remaining: limitPerDay - bucket.count };
}
