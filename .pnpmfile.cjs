// Next lists @playwright/test as an optional peer, for test helpers this repo does not use. Left in, installing
// Playwright in one package (apps/person) makes pnpm resolve a second copy of Next for that package alone, and the
// apps then disagree about Next's types. Dropping the peer keeps one copy of Next for the whole workspace.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'next') {
        delete pkg.peerDependencies?.['@playwright/test'];
        delete pkg.peerDependenciesMeta?.['@playwright/test'];
      }
      return pkg;
    },
  },
};
