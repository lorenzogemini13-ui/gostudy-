function canUpload(plan, uploads) {
  if (!plan) return false;
  if (plan === 'free') return uploads < 3;
  if (plan === 'pro') return true;
  return false;
}

module.exports = { canUpload };
