// Every shape a site's folders can take under /var/www, in one place, so the registry, the fetcher's own
// path check and the deploy all agree on it. Flat is the layout every site had before nesting:
// /var/www/<site> beside /var/www/<site>.git, .prev and .next. Nested keeps them all under one folder:
// /var/www/<site>/{git, live, test, prev/<env>, next/<env>}.

import { posix } from 'node:path'
import type { EnvironmentName } from './registry.ts'

// One segment, and never one that starts with a dot: that alone rules out . and .. anywhere.
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
// Kept in step with ENVIRONMENTS in registry.ts; layout.test.ts fails if the two drift.
const ENV = '(?:live|test)'

export const FLAT_DIR = new RegExp(`^/var/www/${SEGMENT}$`)
export const NESTED_DIR = new RegExp(`^/var/www/${SEGMENT}/${ENV}$`)
// What the fetcher may be pointed at: a flat tree or one of its siblings (all one segment), or a
// nested site's repository, one of its environments, or one of their next and prev copies.
export const FETCH_DIR = new RegExp(`^/var/www/${SEGMENT}(?:/(?:git|${ENV}|(?:next|prev)/${ENV}))?$`)

export const isFlatDir = (dir: string): boolean => FLAT_DIR.test(dir)
export const isNestedDir = (dir: string): boolean => NESTED_DIR.test(dir)

export function siteOf(dir: string): string {
    return isNestedDir(dir) ? posix.dirname(dir) : dir
}

export function nestedEnvOf(dir: string): EnvironmentName | null {
    return isNestedDir(dir) ? posix.basename(dir) as EnvironmentName : null
}

export function nestedDir(site: string, env: EnvironmentName): string {
    return posix.join(site, env)
}
