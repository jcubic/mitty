import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
    {
        ignores: ['node_modules/**', 'dist/**', 'coverage/**']
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: { ...globals.node, ...globals.browser }
        }
    },
    {
        // the example workers run in a worker scope and reach for globals the
        // page/bundle provides
        files: ['example/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.worker,
                Mitty: 'readonly',
                jQuery: 'readonly',
                $: 'readonly'
            }
        }
    },
    prettier
);
