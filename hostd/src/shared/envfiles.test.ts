import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { envPathProblem, envWriteProblem, isEnvFileName } from './envfiles.ts'

describe('isEnvFileName', () => {
    it('recognises the shapes a project actually uses', () => {
        for (const name of ['.env', '.env.local', '.env.test', '.env.production', 'app.env', '.env.example']) {
            assert.equal(isEnvFileName(name), true, name)
        }
    })

    it('rejects anything else, including files that merely mention env', () => {
        for (const name of ['docker-compose.yml', 'environment.ts', 'env.js', '.environment', 'README.md']) {
            assert.equal(isEnvFileName(name), false, name)
        }
    })
})

describe('envPathProblem', () => {
    it('accepts a relative path to an env file, including one in a subfolder', () => {
        assert.equal(envPathProblem('.env'), null)
        assert.equal(envPathProblem('api/.env.test'), null)
    })

    it('refuses an absolute path, a traversal, and a path that leaves the folder', () => {
        assert.match(envPathProblem('/etc/passwd')!, /relative/)
        assert.match(envPathProblem('../.env')!, /outside/)
        assert.match(envPathProblem('api/../../.env')!, /outside/)
    })

    it('refuses a file that is not an env file, which is what keeps this from editing code', () => {
        assert.match(envPathProblem('src/index.ts')!, /env file/)
        assert.match(envPathProblem('docker-compose.yml')!, /env file/)
    })

    it('refuses a path deeper than the limit', () => {
        assert.match(envPathProblem('a/b/c/d/e/.env')!, /deep/)
    })
})

describe('envWriteProblem', () => {
    it('accepts an ordinary env file, same as envPathProblem', () => {
        assert.equal(envWriteProblem('.env'), null)
        assert.equal(envWriteProblem('api/.env.test'), null)
    })

    // .env.example is a valid env file name (isEnvFileName accepts it), so envPathProblem lets it be
    // listed and read; only a write draws the line, since the repo tracks the .example in Git.
    it('refuses to write an .example file even though it is a valid env file name to read', () => {
        assert.equal(envPathProblem('.env.example'), null)
        assert.match(envWriteProblem('.env.example')!, /read-only/)
    })

    it('still refuses anything envPathProblem already refuses, for the same reason', () => {
        assert.match(envWriteProblem('/etc/passwd')!, /relative/)
        assert.match(envWriteProblem('src/index.ts')!, /env file/)
    })
})
