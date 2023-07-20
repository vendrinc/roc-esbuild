const exclaim = require('./exclaim');

test('exclaim("Hi, World") adds a "!" to the end', () => {
  expect(exclaim("Hi, World")).toBe("Hi, World!");
});
