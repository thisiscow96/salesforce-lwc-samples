// LWC 공식 권장 규칙(@salesforce/eslint-config-lwc, ESLint 9 flat config)
const lwcConfig = require('@salesforce/eslint-config-lwc');

module.exports = [
    { ignores: ['**/staticresources/**', 'node_modules/**', '.sf/**', '.sfdx/**', 'deploy/**', '*.config.js', 'jest.setup.js'] },
    ...lwcConfig.configs.recommended,
    {
        files: ['**/__tests__/**/*.js'],
        languageOptions: {
            globals: { jest: 'readonly', describe: 'readonly', it: 'readonly', expect: 'readonly', beforeEach: 'readonly', afterEach: 'readonly', require: 'readonly', module: 'writable' }
        }
    }
];
