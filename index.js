/**
 * @author a4i
 *
 * Plugin to validate authentication, mailfrom, rcptto via rules stored in a posgresql database.
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

exports.register = function () {

    // depuis auth-enc-file
    this.inherits('auth/auth_base');

    this.logdebug("Initializing pg-profile plugin.");
    const config = this.config.get('pg-profile.json');

    const dbConfig = {
        user: config.user,
        database: config.database,
        password: config.password,
        host: config.host,
        port: config.port,
        max: config.max,
        idleTimeoutMillis: config.idleTimeoutMillis
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
    this.profiles_query = config.profiles_query;
    this.users_query = config.users_query;
    // domain to append to username to create from mail when not specified :
    this.default_domain = config.default_domain;
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

    let client;
    try {
        client = await plugin.pool.connect();
    } catch (e) {
        plugin.logerror('Error connecting to pg pool. ' + e);
        return next(new Error('Error connecting to pg pool. ' + e));
    }

    let result;
    try {
        result = await client.query(plugin.profiles_query);
    } catch (e) {
        plugin.logerror('Error fetching profiles from pool. ' + e);
        return next(new Error('Error fetching profiles from pg. ' + e));
    }

                result.rows.map(r => {
                    plugin.profiles["p-"+r.id] = {
                        ...r,
                        rcpt: r.rcpt ? r.rcpt.split(','): [],
                        rcpt_re: r.rcpt_re ? r.rcpt_re.split(',').map(r => {
                            return new RegExp(r)
                            }) : null,
                        host: r.host ? r.host.split(','): [],
                    };

                });
                console.log(util.inspect(plugin.profiles, {showHidden: false, depth: null}))


    try {
        result = await client.query(plugin.users_query)
    } catch (e) {
        plugin.logerror('Error fetching users from pg. ' + e);
        return next(new Error('Error fetching users from pg. ' + e));
    }
    result.rows.map(r => {plugin.users[ r.user ] = {
        ...r,
        froms: r.froms ? r.froms.split(',') : [r.user + "@" + plugin.default_domain],
    }});
    console.log(util.inspect(plugin.users, {showHidden: false, depth: null}))

    client.release();
    plugin.cfg = {'done': true}

    nextOnce();
    return true;

};

exports.check_plain_passwd = function (connection, user, passwd, cb) {
    const plugin = this;
    if (plugin.users.hasOwnProperty(user) && plugin.users[user].password) {
        try {
            const [method, id, salt, hash] = plugin.users[user].password.split('$');
            const authenticated = cb(sha512crypt(passwd, salt) === `$${id}$${salt}$${hash}`);
            connection.loginfo(`User ${user} authentication: ${authenticated}`);
            return authenticated
        } catch (e) {
            connection.logerror(`Unable to verify password for user ${user}`)
            return cb(false);
        }
    }
    connection.loginfo(`User ${user} unknown`);
    return cb(false);
}

exports.hook_mail = function (next, connection, params) {
    const plugin = this;

    const mail_from = params[0].address();
    const auth_user = connection.notes.auth_user;
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
}

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
    const auth_user = connection.notes.auth_user
    if (!connection.notes.auth_user || !plugin.users.hasOwnProperty(auth_user) || !plugin.users[auth_user]) {
        connection.loginfo("No authenticated user found => no rcpt check");
        next();
        return;
    }

    const user = plugin.users[auth_user];
    const profile = plugin.profiles["p-"+user["profile"] ];

    if (!profile) {
        connection.loginfo(`No profile ${"p-"+user["id"]} found for user ${auth_user} => no rcpt check`);
        next();
        return;
    }

    connection.loginfo(`****** User "${auth_user}" has profile "${profile['name']}"`);

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
    connection.loginfo(`********* looking for  ${rcptto} ****************`);

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

    next();
};

exports.shutdown = function () {
    this.loginfo("Shutting down validity plugin.");
    this.pool.end();
};

