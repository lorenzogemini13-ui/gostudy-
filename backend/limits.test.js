const { canUpload } = require('./limits');

test('free users are limited to 3 uploads', () => {
  expect(canUpload('free', 0)).toBe(true);
  expect(canUpload('free', 2)).toBe(true);
  expect(canUpload('free', 3)).toBe(false);
});

test('pro users have no upload limit', () => {
  expect(canUpload('pro', 100)).toBe(true);
});

test('unknown plans are rejected', () => {
  expect(canUpload('alien', 0)).toBe(false);
});

test('missing plan is rejected', () => {
  expect(canUpload(undefined, 0)).toBe(false);
});
