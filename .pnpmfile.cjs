'use strict'

const dependencyFields = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]

const firstPartyPackageNames = new Set([
  '@pwrdrvr/agent-kit-root',
  'minimal-consumer',
])
const firstPartyPackagePrefix = '@pwrdrvr/'

function isFirstParty(pkg) {
  if (!pkg || typeof pkg.name !== 'string') return false
  if (firstPartyPackageNames.has(pkg.name)) return true
  return pkg.name.startsWith(firstPartyPackagePrefix)
}

const gitSpecPattern = /^(?:git(?:\+|:)|git@|ssh:\/\/git@|github:|gitlab:|bitbucket:|https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\.com\/|[^/@\s]+\/[^/\s]+(?:#.*)?$)/

function isGitSpec(spec) {
  return typeof spec === 'string' && gitSpecPattern.test(spec)
}

function scanField(pkg, field) {
  const dependencies = pkg[field]
  if (!dependencies) return
  for (const [name, spec] of Object.entries(dependencies)) {
    if (isGitSpec(spec)) {
      throw new Error(`Blocked git dependency ${name}@${spec} (in ${pkg.name ?? '<unknown>'}.${field})`)
    }
  }
}

function readPackage(pkg) {
  for (const field of dependencyFields) {
    scanField(pkg, field)
  }
  if (isFirstParty(pkg)) {
    scanField(pkg, 'devDependencies')
  }
  return pkg
}

function blockGitFetcher() {
  return async () => {
    throw new Error('Blocked pnpm git dependency fetch')
  }
}

module.exports = {
  hooks: {
    readPackage,
    fetchers: {
      git: blockGitFetcher,
      gitHostedTarball: blockGitFetcher,
    },
  },
}
