const { jestConfig } = require('@salesforce/sfdx-lwc-jest/config');

module.exports = {
    ...jestConfig,
    modulePathIgnorePatterns: ['<rootDir>/.localdevserver'],
    // __tests__/data 는 테스트 데이터·헬퍼 (테스트 파일 아님)
    testPathIgnorePatterns: ['/node_modules/', '/__tests__/data/'],
    moduleNameMapper: {
        ...jestConfig.moduleNameMapper,
        '^lightning/modal$': '<rootDir>/jest-mocks/lightning/modal',
        '^lightning/actions$': '<rootDir>/jest-mocks/lightning/actions'
    },
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js']
};
