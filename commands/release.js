'use strict';
/* eslint no-sync: 0 */
/**
 * @see [Atom's publish-build-task.coffee](https://git.io/vaYu3)
 * - https://github.com/atom/electron/blob/master/script/create-dist.py
 */

/**
 * TODO (imlucas) If darwin, dump symbols for breakpad
 * and include in assets.
 * @see [Atom's dump-symbols-task.coffee](https://git.io/va3fG)
 */
const Promise = require('bluebird');
const config = require('../lib/config');
const cli = require('mongodb-js-cli')('hadron-build:release');
const util = require('util');
const format = util.format;
const glob = require('glob');
const path = require('path');
const del = require('del');
const fs = require('fs-extra');
const _ = require('lodash');
const async = require('async');
const asar = require('asar');
const packager = require('electron-packager');
const run = require('electron-installer-run');
const zip = require('electron-installer-zip');
const license = require('electron-license');
const ModuleCache = require('hadron-module-cache');
const CompileCache = require('hadron-compile-cache');

const pkg = require('../lib/package');
const ui = require('./ui');
const verify = require('./verify');

exports.command = 'release';

exports.describe = ':shipit:';

const COMPILE_CACHE = '.compiled-sources';
const CACHE_PATTERN = '**/*.{jade,jsx}';

/**
 * Clean out the existing development compile cache.
 *
 * @param {Object} CONFIG
 * @param {Function} done
 * @api public
 */
function cleanCompileCache(CONFIG, done) {
  cli.debug('cleaning out development compile cache');
  fs.remove(path.resolve(CONFIG.dir, COMPILE_CACHE), function() {
    done();
  });
}

/**
 * Create a precompiled cache of .jade and .jsx sources.
 *
 * @param {Object} CONFIG
 * @param {Function} done
 * @api public
 */
function createCompileCache(CONFIG, done) {
  cli.debug('creating compile cache');
  CompileCache.setHomeDirectory(CONFIG.dir);
  glob(`src/${CACHE_PATTERN}`, function(error, files) {
    cli.abortIfError(error);
    _.each(files, function(file) {
      var compiler = CompileCache.COMPILERS[path.extname(file)];
      CompileCache.compileFileAtPath(compiler, file);
    });
    done();
  });
}

/**
 * Run `electron-packager`
 *
 * @see https://npm.im/electron-packager
 * @param {Object} CONFIG
 * @param {Function} done
 * @api public
 */
function createBrandedApplication(CONFIG, done) {
  cli.debug('running electron-packager');
  packager(CONFIG.packagerOptions, function(err, res) {
    if (err) {
      return done(err);
    }
    cli.debug('Packager result is: ' + JSON.stringify(res, null, 2));
    done(null, true);
  });
}

/**
 * For some platforms, there will be extraneous (to us) folders generated
 * we can remove to make the generated branded app less cluttered and easier
 * to debug.
 *
 * @param {Object} CONFIG
 * @param {Function} done
 * @api public
 */
function cleanupBrandedApplicationScaffold(CONFIG, done) {
  if (CONFIG.platform === 'linux') {
    done(null, true);
    return;
  }

  var globsToDelete = [];
  if (CONFIG.platform === 'win32') {
    globsToDelete.push(path.join(CONFIG.resources, '*.pak'));
  } else {
    globsToDelete.push(path.join(CONFIG.resources, '*.lproj'));
  }

  cli.debug('cleaning up extraneous files from template');
  del(globsToDelete, {
    force: true
  }).then(function(paths) {
    cli.debug(format('%d extraneous files removed', paths.length));
    done(null, true);
  }, done);
}

/**
 * Replace the LICENSE file `electron-packager` creates w/ a LICENSE
 * file specific to the project.
 *
 * @see [Atom's generate-license-task.coffee](https://git.io/vaZI7)
 * @param {Object} CONFIG
 * @returns {Promise}
 * @api public
 */
let writeLicenseFile = (CONFIG) => {
  var LICENSE_DEST = path.join(CONFIG.appPath, '..', 'LICENSE');
  var opts = {
    dir: CONFIG.dir,
    production: true,
    excludeOrg: 'mongodb-js,10gen,christkv'
  };
  return license.build(opts)
    .then((contents) => {
      fs.writeFileSync(LICENSE_DEST, contents);
      cli.debug(format('LICENSE written to `%s`', LICENSE_DEST));
    });
};

/**
 * Replace the version file `electron-packager` creates w/ a version
 * file specific to the project.
 *
 * @see [Atom's set-version-task.coffee](https://git.io/vaZkN)
 * @param {Object} CONFIG
 * @returns {Promise}
 * @api public
 */
let writeVersionFile = (CONFIG) => {
  const VERSION_DEST = path.join(CONFIG.appPath, '..', 'version');
  return new Promise((resolve, reject) => {
    cli.debug(format('Writing version file to `%s`', VERSION_DEST));
    fs.writeFile(VERSION_DEST, CONFIG.version, function(err) {
      if (err) {
        return reject(err);
      }
      cli.debug(format('version file written to `%s`', VERSION_DEST));
      resolve(CONFIG.version);
    });
  });
};

/**
 * Update the project's `./package.json` (like npm does when it
 * installs a package) for inclusion in the application
 * `electron-packager` creates.
 *
 * @param {Object} CONFIG
 * @param {Function} done
 * @api public
 */
function transformPackageJson(CONFIG, done) {
  var PACKAGE_JSON_DEST = path.join(CONFIG.resources, 'app', 'package.json');
  var packageKeysToRemove = [
    'scripts',
    'devDependencies',
    'dependency-check',
    'repository',
    'check',
    'config.hadron.build'
  ];
  var contents = _.omit(pkg, packageKeysToRemove);

  if (!contents.config) {
    contents.config = {};
  }
  _.defaults(contents.config, {
    NODE_ENV: 'production',
    build_time: new Date().toISOString(),
    channel: CONFIG.channel,
    revision: cli.argv.revision,
    build_variant: cli.argv.build_variant,
    branch_name: cli.argv.branch_name
  });

  cli.debug('Writing ' + PACKAGE_JSON_DEST + ': ' +
    JSON.stringify(contents, null, 2));
  fs.writeFile(PACKAGE_JSON_DEST, JSON.stringify(contents, null, 2), done);
}

/**
 * TODO (imlucas) Cache this... http://npm.im/npm-cache ?
 * @see [Atom's fingerprint-task.js](https://git.io/vaZLq)
 * @see [Atom's fingerprint.js](https://git.io/vaZLZ)
 * @see [Atom's generate-module-cache-task.coffee](https://git.io/vaY0O)
 * @see [Atom's native-compile-cache](https://git.io/vaY0a)
 * @see [Atom's module-cache.coffee](https://git.io/vaY0K)
 *
 * @param {Object} CONFIG
 * @param {Function} done
 * @api public
 */
function installDependencies(CONFIG, done) {
  var args = [
    'install',
    '--production'
  ];
  cli.debug('Installing dependencies');
  var opts = {
    env: process.env,
    cwd: path.join(CONFIG.resources, 'app')
  };
  run('npm', args, opts, function(err) {
    if (err) {
      return done(err);
    }
    cli.debug('Dependencies installed');
    done();
  });
}

/**
 * Before creating installers for distribution to
 * customers, there are thousands of files
 * they don't need in order to run the application.
 *
 * TODO (imlucas) even more we can remove!  see
 * `EXCLUDE_FROM_RELEASE` in INT-1225.
 *
 * @see https://jira.mongodb.org/browse/INT-1225
 * @param {Object} CONFIG
 * @param {Function} done
 * @api public
 */
function removeDevelopmentFiles(CONFIG, done) {
  if (CONFIG.platform !== 'darwin') {
    done();
    return;
  }
  var DOT_FILES = [
    '.DS_Store',
    '.eslint*',
    '.evergreen*',
    '.travis*',
    '.npm*',
    '.jsfmt*',
    '.git*',
    'report*'
  ];

  var globsToDelete = [
    path.join(CONFIG.resources, 'app', 'test'),
    path.join(CONFIG.resources, 'app', 'scripts')
  ];

  if (CONFIG.platform === 'darwin') {
    globsToDelete.push(path.join(CONFIG.resources,
      'app', '{' + DOT_FILES.join(',') + '}'));
  }

  cli.debug('Checking for extraneous files to remove:\n' +
    JSON.stringify(globsToDelete, null, 2));

  del(globsToDelete).then(function(paths) {
    if (paths.length === 0) {
      cli.debug('No extraneous files to remove');
    } else {
      cli.debug(format('%s extraneous files removed', paths.length));
    }
    done(null, true);
  }, done);
}

/**
 * Package the application as a single `asar` file.
 *
 * @see [Atom's generate-asar-task.coffee](https://git.io/vaY4O)
 * @see https://gist.github.com/imlucas/7a8956cf153595168109
 * @see https://jira.mongodb.org/browse/INT-1225
 * @param {Object} CONFIG
 * @param {Function} done
 */
function createApplicationAsar(CONFIG, done) {
  var opts = {
    /**
     * TODO (imlucas) Find a good way to automate generating
     * the hints file using `ELECTRON_LOG_ASAR_READS=1`.
     *
     *  ordering: path.join(process.cwd(),
     *   'resources', 'asar-ordering-hint.txt'),
     */
    unpack: '{' + [
      '*.node',
      '**/vendor/**'
    ].join(',') + '}'
  };

  var src = path.join(CONFIG.resources, 'app');
  var dest = path.join(CONFIG.resources, 'app.asar');

  asar.createPackageWithOptions(src, dest, opts, function() {
    del(src, {force: true}).then(function() {
      done();
    }, done);
  });
}

/**
 * Packages the app as a plain zip using `electron-installer-zip`
 * for auto updates.
 *
 * NOTE (imlucas) This should be run after the installers have been
 * created.  The modules that generate the installers also
 * handle signinging the assets. If we zip unsigned assets
 * and publish them for the release, auto updates will be rejected.
 *
 * @param {Object} CONFIG
 * @param {Function} done
 */
function createApplicationZip(CONFIG, done) {
  if (CONFIG.platform === 'linux') {
    done();
    return;
  }

  var DIR = CONFIG.appPath;

  var OUT = CONFIG.assets.filter(function(asset) {
    return path.extname(asset.path) === '.zip';
  })[0].path;
  cli.debug('Zipping `%s` to `%s`', DIR, OUT);

  var options = {
    dir: DIR,
    out: OUT,
    platform: CONFIG.platform
  };

  zip(options, done);
}

/**
 * Create the application installer.
 *
 * @param {Object} CONFIG
 * @param {Function} done
 * @api public
 */
function createBrandedInstaller(CONFIG, done) {
  cli.debug('Creating installer');
  CONFIG.createInstaller(done);
}

let createModuleCache = (CONFIG, done) => {
  const appDir = path.join(CONFIG.resources, 'app');
  ModuleCache.create(appDir);

  let metadata = pkg.get(appDir);

  for (let folder in _.get(metadata, '_compassModuleCache.folders')) {
    if (_.includes(folder.paths, '')) {
      folder.paths = ['', 'test', 'src', 'src/app'];
    }
  }
  fs.writeFile(metadata._path, JSON.stringify(metadata, null, 2), done);
};

exports.builder = {};

_.assign(exports.builder, config.options, ui.builder, verify.builder);

exports.handler = (argv) => {
  cli.argv = argv;

  let CONFIG = config.get(cli);

  var tasks = _.flatten([
    function(cb) {
      verify.tasks(argv)
        .then(() => ui.tasks(argv))
        .then(() => cb())
        .catch(cb);
    },
    _.partial(cleanCompileCache, CONFIG),
    _.partial(createCompileCache, CONFIG),
    _.partial(createBrandedApplication, CONFIG),
    _.partial(cleanupBrandedApplicationScaffold, CONFIG),
    function(cb) {
      Promise.all([
        writeLicenseFile(CONFIG),
        writeVersionFile(CONFIG)
      ]).then(() => cb()).catch(cb);
    },
    _.partial(transformPackageJson, CONFIG),
    _.partial(installDependencies, CONFIG),
    _.partial(createModuleCache, CONFIG),
    _.partial(removeDevelopmentFiles, CONFIG),
    _.partial(createApplicationAsar, CONFIG),
    _.partial(createBrandedInstaller, CONFIG),
    _.partial(createApplicationZip, CONFIG)
  ]);

  async.series(tasks, (_err) => {
    cli.abortIfError(_err);
    cli.ok(format('%d assets successfully built',
      CONFIG.assets.length));
    CONFIG.assets.map(function(asset) {
      cli.info(asset.path);
    });
  });
};
