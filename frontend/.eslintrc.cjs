/**
 * One rule, enforced: React's rules of hooks. A hook declared after an early return
 * ("if (loading) return …") crashed every utility account page once it loaded
 * ("Rendered more hooks than during the previous render"); this catches it before it ships.
 * Type checking is tsc's job; style is not linted.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['react-hooks'],
  rules: {
    'react-hooks/rules-of-hooks': 'error',
  },
  // Comments left from an earlier setup name this rule; it is not enforced.
  reportUnusedDisableDirectives: false,
  ignorePatterns: ['dist', 'node_modules', 'ios', 'public', 'scripts'],
};
