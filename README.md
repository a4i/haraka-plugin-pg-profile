# haraka-plugin-pg-profile

Validates authentication, mailfrom, rcptto via rules stored in a posgresql database.

## Install

    cd /my/haraka/config/dir
    npm install haraka-plugin-pg-profile

### Create database

```sql
CREATE TABLE haraka.profiles (
    id integer NOT NULL,
    name character varying(255),
    "desc" character varying(255),
    open boolean DEFAULT false NOT NULL,
    limits text,
    maxsize integer DEFAULT 0 NOT NULL,
    host text,
    rcpt text,
    rcpt_re text,
    "createdAt" timestamp with time zone DEFAULT ('now'::text)::timestamp(3) with time zone,
    "updatedAt" timestamp with time zone DEFAULT ('now'::text)::timestamp(3) with time zone
);
CREATE SEQUENCE haraka.profiles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER TABLE ONLY haraka.users ALTER COLUMN id SET DEFAULT nextval('haraka.users_id_seq'::regclass);

CREATE TABLE haraka.users (
    id integer NOT NULL,
    username character varying(128) NOT NULL,
    password character varying(255) NOT NULL,
    froms text,
    "createdAt" timestamp with time zone DEFAULT ('now'::text)::timestamp(3) with time zone,
    "updatedAt" timestamp with time zone DEFAULT ('now'::text)::timestamp(3) with time zone,
    "profileId" integer
);
CREATE SEQUENCE haraka.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER TABLE ONLY haraka.profiles ALTER COLUMN id SET DEFAULT nextval('haraka.profiles_id_seq'::regclass);
```

#### Use triggers to refresh cache

The plugin uses LISTEN/PUBLISH Postgresql pattern, listening to events from the *haraka* channel.

When an event is received, *users* and *profiles* tables are scanned to rebuild in-memory and file caches.

You can use triggers to emit events. Here events are sent for every db update. Maybe your use case let you do better :

```sql
CREATE OR REPLACE FUNCTION notify_haraka()
  RETURNS trigger AS
$BODY$
    BEGIN
        PERFORM pg_notify('haraka', TG_TABLE_NAME || '-' || TG_OP);
        RETURN NULL;
    END;
$BODY$
  LANGUAGE plpgsql VOLATILE
COST 100;

CREATE TRIGGER notify_haraka
  AFTER INSERT OR UPDATE OR DELETE
  ON "users"
  FOR EACH ROW
EXECUTE PROCEDURE notify_haraka();
CREATE TRIGGER notify_haraka
  AFTER INSERT OR UPDATE OR DELETE
  ON "profiles"
  FOR EACH ROW
EXECUTE PROCEDURE notify_haraka();
```

Note that every Haraka fork (see *nodes* directive in smtp.ini) will open and maintain one connection to PG to receive notifications.

### Enable

Add the following line to the `config/plugins` file.

`pg-profile`

## Config

The `pg-profile.json` file has the following structure (defaults shown). Also note that this file will need
to be created, if not present, in the `config` directory.

```javascript
{
  "user": "pguser",
  "database": "haraka",
  "password": "",
  "host": "127.0.0.1",
  "port": 5432,
  "schema": "haraka",
  "max": 20,
  "idleTimeoutMillis": 30000,
  "default_domain": "example.com",
  "jwt_secret": "secret4jwt",
  "use_file_cache": true,
  "file_cache'path": "/path/to/store.json",
  "profiles_query": "SELECT * FROM profiles",
  "users_query": "SELECT * FROM users"
}
```

### Profiles table

Populate your profiles this way :
* name : for log readability
* desc : description, no use actually
* open : if True, no restriction applies to users with this profile (not emplemented yet)
* limits : comma separated list of limits. See haraka-plugin-limit. Ex: 1/5m,500/1d. All limits must be respected.
* maxsize : max total size in bytes. config/databytes will apply too.
* rcpt : comma separated list of emails this profile can send mail to (optional)
* rcpt_re : comma separated list of regexp to check emails addresses this profile can send mail to (optional)
* host : comma separated list of domains this profile can send mail to (optional)

### Users table

Populate your users this way :
* username : username used for SMTP authentication
* password : SHA512 encoded password for SMTP authentication (see auth-enc-file plugin)
* profileId : profile id this user belongs to
* froms : comma separated list of emails addresses this user can user for envelope MAIL FROM

All profiles and users are fetched at startup and kept in memory. They are stored in a local cache too, in case
of restart during a Postresql outage.

## JWT authentication

Users can authenticate using a JWT with a **mail** payload field.

In this case, a profile named **token** must be present in the *profiles* table.
This profile will be use for every JWT authenticated users. They don't have to be present in the
users table (therefore you can't set different *from* mail addresses, and they have to use the only mail
present in the token).
