import tseslint from 'typescript-eslint';

export default tseslint.config(...tseslint.configs.recommended, {
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    eqeqeq: ['error', 'always', { null: 'ignore' }],
  },
});
