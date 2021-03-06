/* eslint-disable no-trailing-spaces */
/**
 * @author a4i
 *
 * Plugin to validate authentication, mailfrom, rcptto, maxsize via rules stored in a posgresql database.
 * It allows login via JWT : set 'token' as login, and the jsonwebtoken as password. This JWT must hold
 * the mail sender in a 'mail' payload field.
 *
 * Based on :
 * - https://github.com/haraka/haraka-plugin-rcpt-postgresql
 * - https://github.com/AuspeXeu/haraka-plugin-auth-enc-file
 */

/* global server */

const pg        = require('pg');
const util      = require('util');

const constants = require('haraka-constants');

// from auth-enc-file
const {sha512crypt} = require('sha512crypt-node');
exports.hook_capabilities = function (next, connection) {
    // Don't offer AUTH capabilities by default unless session is encrypted
    if (connection.tls.enabled) {
        const methods = ['PLAIN', 'LOGIN'];
        connection.capabilities.push(`AUTH ${methods.join(' ')}`);
        connection.notes.allowed_auth_methods = methods;
    }
    next();
}

const jwt = require('jsonwebtoken');

exports.register = function () {

    // depuis auth-enc-file
    this.inherits('auth/auth_base');

    this.logdebug("Initializing pg-profile plugin.");
    const config = this.config.get('pg-profile.json');

    this.config = {...config};

    const dbConfig = {
        user: config.user,
        database: config.database,
        password: config.password,
        host: config.host,
        port: config.port,
        max: config.max,
        search_path: config.schema,
        schema: config.schema,
        idleTimeoutMillis: config.idleTimeoutMillis,
    };

    //Initialize the connection pool.
    this.pool = new pg.Pool(dbConfig);

    /**
     * If an error is encountered by a client while it sits idle in the pool the pool itself will emit an
     * error event with both the error and the client which emitted the original error.
     */
    this.pool.on('error', function (err, client) {
        this.logerror('Idle client error. Probably a network issue or a database restart.'
            + err.message + err.stack);
    });

    this.register_hook('init_master', 'init_pg_profile_shared');
    this.register_hook('init_child', 'init_pg_profile_shared');
    //this.sqlQuery = config.sqlQuery;
    // domain to append to username to create from mail when not specified :

    if (this.config.use_file_cache) {
        const file_cache_path = config.file_cache_path || "store.json";
        this.cache = require('node-file-cache').create({ life: 3600 * 24 * 365 * 10, file: file_cache_path });
    }

    this.profiles = {};
    this.users = {};
};

exports.init_pg_profile_shared = async function (next, server) {
    const plugin = this;
    let calledNext = false;
    // see https://github.com/haraka/haraka-plugin-redis/blob/master/index.js
    function nextOnce (e) {
        if (e) plugin.logerror('PG PROFILE error: ' + e.message);
        if (calledNext) return;
        calledNext = true;
        next();
    }
    function pg_done () {
        plugin.cfg = {'done': true};
        plugin.logdebug(util.inspect(plugin.profiles, {showHidden: false, depth: null}));
        plugin.logdebug(util.inspect(plugin.users, {showHidden: false, depth: null}));
        nextOnce();
        return true;
    }

    async function load_config_from_pg () {
        plugin.loginfo('>>>>>>>> load conf from pg');

        let psql;
        let done = false;

        try {
            psql = await plugin.pool.connect();
        } catch (e) {
            plugin.logerror('Error connecting to pg pool. ' + e);
            return false; // le caller doit utiliser le cache fichier si dispo
        }

        try {
            let result;
            let users = {};
            let profiles = {};

            await psql.query(`SET SCHEMA '${plugin.config.schema}'`);
            result = await psql.query(plugin.config.profiles_query);

            result.rows.map(r => {
                profiles[r.name === 'token' ? 'token' : "p-"+r.id] = {
                    ...r,
                    limits: r.limits ? r.limits.split(','): [],
                    rcpt: r.rcpt ? r.rcpt.split(','): [],
                    rcpt_re: r.rcpt_re ? r.rcpt_re.split(',').map(rr => {
                        return new RegExp(rr)
                    }) : null,
                    host: r.host ? r.host.split(','): [],
                };

            });
            plugin.profiles = profiles;
            plugin.cache.set('profiles', plugin.profiles);

            result = await psql.query(plugin.config.users_query)
            result.rows.map(r => {
                users[ r.username ] = {
                    ...r,
                    froms: r.froms ? r.froms.split(',') : [r.username + "@" + plugin.config.default_domain],
                }});
            plugin.users = users;
            plugin.cache.set('users', plugin.users);

            plugin.loginfo(`>>>>>>>> Loaded ${Object.keys(users).length} users and ${Object.keys(profiles).length} profiles from PG`);

            done = true;

        } catch (e) {
            plugin.logerror('Error fetching conf from pg: ' + e);
        } finally {
            psql.release();
        }

        return done;
    }

    let client;
    try {
        client = await plugin.pool.connect();

        client.on('notification', async function (msg) {
            plugin.loginfo('>>>>>>>>>>>>>>>> PG_NOTIFICATION '+JSON.stringify(msg));
            await load_config_from_pg();
        });

        client.query('LISTEN haraka');

    } catch (e) {
        plugin.logerror('Error connecting to pg pool. ' + e);

        if (! plugin.config.use_file_cache) {
            return next(new Error('Error connecting to pg pool (and no cache configured): ' + e));
        } else {

            plugin.loginfo('Using file cache');
            plugin.profiles = plugin.cache.get('profiles');
            if (!plugin.profiles) {
                plugin.logerror('No profile cache found');
                return next(new Error('No profile cache found'));
            }

            plugin.users = plugin.cache.get('users');
            if (!plugin.users) {
                plugin.logerror('No user cache found');
                return next(new Error('No user cache found'));
            }

            return pg_done();
        }
    }

    await load_config_from_pg();

    //???client.release();
    return pg_done();

};

exports.check_plain_passwd = function (connection, user, passwd, cb) {
    const plugin = this;

    if (user === "token") {
        jwt.verify(passwd, plugin.config.jwt_secret, (err, decoded) => {
            if (err) {
                connection.loginfo(`Token invalid ${passwd}`);
                return cb(false)
            }
            connection.loginfo('Token OK', decoded);
            connection.notes.jwt_mail = decoded.mail;
            return cb(true)
        });
    }
    else if (plugin.users.hasOwnProperty(user) && plugin.users[user].password) {
        try {
            const [method, id, salt, hash] = plugin.users[user].password.split('$');
            const authenticated = cb(sha512crypt(passwd, salt) === `$${id}$${salt}$${hash}`);
            connection.loginfo(`User ${user} authentication: ${authenticated}`);
            return authenticated
        } catch (e) {
            connection.logerror(`Unable to verify password for user ${user}`)
            return cb(false);
        }
    } else {
        connection.loginfo(`User ${user} unknown`);
        return cb(false);
    }
};

exports.hook_mail = function (next, connection, params) {
    const plugin = this;

    const mail_from = params[0].address();
    const auth_user = connection.notes.auth_user;
    if (auth_user === 'token') {
        if (mail_from !== connection.notes.jwt_mail) {
            connection.loginfo(`Tokenized MAIL FROM ${mail_from} check failed for user ${connection.notes.jwt_mail}`);
            return next(DENY, 'Your token is not authorized to send from this address');
        }
        connection.loginfo(`MAIL FROM check pass for ${mail_from}`);
        return next();
    }
    if (!auth_user || !plugin.users.hasOwnProperty(auth_user) || !plugin.users[auth_user]) {
        connection.loginfo("No authenticated user found => no MAIL FROM check");
        return next();
    }
    const authorized = plugin.users[auth_user].froms.indexOf(mail_from) >= 0;

    if (!authorized) {
        connection.loginfo(`User ${auth_user} is not allowed to MAIL FROM: ${mail_from}`)
        return next(DENY, 'You are not authorized to send from this address');
    }
    return next();
};

exports.hook_rcpt = function (next, connection, params) {
    let calledNext = false;
    function nextOnce (e) {
        if (e) plugin.logerror('PG PROFILE error: ' + e.message);
        connection.loginfo(`*** nextOnce : calledNext=${calledNext}`)
        if (calledNext) return;
        calledNext = true;
        next();
    }

    const rcpt = params[0];

    const plugin = this;
    const auth_user = connection.notes.auth_user;
    if (auth_user === 'token') {
        connection.loginfo('No rcpt check for token user '+connection.notes.jwt_mail);
        return next();
    }
    if (!connection.notes.auth_user || !plugin.users.hasOwnProperty(auth_user) || !plugin.users[auth_user]) {
        connection.loginfo("No authenticated user found => no rcpt check");
        next();
        return;
    }

    const user = plugin.users[auth_user];
    const profile = plugin.profiles["p-"+user.profileId ];

    if (!profile) {
        connection.logerror(`No profile ${"p-"+user.profileId} found for user ${auth_user} => no rcpt check`);
        next();
        return;
    }

    connection.loginfo(`User "${auth_user}" has profile "${profile.name}"`);

    if (profile.open) {
        connection.loginfo(`User ${auth_user} has openbar`);
        return next();
    }

    if (profile.host.indexOf(rcpt.host) >= 0) {
        connection.loginfo(`User ${auth_user} can send to host ${rcpt.host}`);
        next();
        return;
    }

    const rcptto = rcpt.user + "@" + rcpt.host;
    connection.loginfo(`Looking for rcptto ${rcptto}`);

    if (profile.rcpt.indexOf(rcptto) >= 0) {
        connection.loginfo(`User ${auth_user} can send to rcpt ${rcpt.original}`);
        next();
        return;
    }

    if (profile.rcpt_re) {

        profile.rcpt_re.map(r => {
            if (rcptto.match(r)) {
                connection.loginfo(`User ${auth_user} can send to rcpt_re ${rcpt.original} (${r})`);
                nextOnce();
            } else {
                connection.loginfo(`User ${auth_user} CAN'T send to rcpt_re ${rcpt.original} (${r}). Going on`);
            }
        });
        if (calledNext)  {
            connection.logdebug('nextOnce previously called')
            return;
        }
    }

    connection.results.add(plugin, {fail:'rcpt'})
    next(constants.DENYDISCONNECT, `User ${auth_user} not allowed to send to rcpt ${rcpt.original}`);
};

/* INUTILE PAR LE DENYDISCONNECT de RCPT
exports.hook_data = function (next, connection, params) {

if (connection.results.has('pg-profile', 'fail', 'rcpt')) {
    next(constants.DENY, `User ${connection.notes.auth_user} not allowed to send to at least on rcpt`);
    return;
}

    next();
}*/

exports.hook_data_post = function (next, connection) {

    // attention, les plugins peuvent mettre des results dans connection.results, ou comme ici dans
    // connection.transaction.results
    if (connection.transaction.results.has('data.headers', 'fail', /^from_match/)) {
        connection.loginfo('Envelope and body FROM mismatch')
        return next(constants.DENY, `Envelope and body FROM mismatch`);
    }

    const plugin = this;
    const token = connection.notes.auth_user === 'token';
    const auth_user = token ? connection.notes.jwt_mail : connection.notes.auth_user;
    if (!token) {
        if (!connection.notes.auth_user || !plugin.users.hasOwnProperty(auth_user) || !plugin.users[auth_user]) {
            connection.loginfo("No authenticated user found => no size check");
            next();
            return;
        }
    }

    const user = token ? null : plugin.users[auth_user];
    const profile = plugin.profiles[token ? 'token' : "p-"+user.profileId ];

    if (!profile) {
        connection.logerror(`No profile found for user ${auth_user} => no size check`);
        next();
        return;
    }

    if (profile.maxsize && connection.transaction.data_bytes > profile.maxsize) {
        this.logerror(`Incoming message exceeded databytes size of ${profile.maxsize}`);
        return next(constants.DENY, `Message too big for you!`);
    }

    next();
};

exports.shutdown = function () {
    this.loginfo("Shutting down validity plugin.");
    this.pool.end();
};

