# haraka-plugin-pg-profile

Validates authentication, mailfrom, rcptto via rules stored in a posgresql database.

## Install

    cd /my/haraka/config/dir
    npm install haraka-plugin-pg-profile

### Create database

```sql
CREATE TABLE public.profile (
    id integer NOT NULL,
    name character varying(128) NOT NULL,
    "desc" text,
    rcpt text,
    rcpt_re text,
    host text,
    open boolean DEFAULT false NOT NULL
);

CREATE TABLE public."user" (
    id integer NOT NULL,
    "user" character varying(128) NOT NULL,
    password character varying(256) NOT NULL,
    profile integer NOT NULL,
    froms text DEFAULT ''::text,
    "limit" character varying(128) DEFAULT NULL::character varying
);

```
You should create autoincrement sequences for id columns.

### Enable

Add the following line to the `config/plugins` file.

`pg-profile`

## Config

The `pg-profile.json` file has the following structure (defaults shown). Also note that this file will need to be created, if not present, in the `config` directory.

```javascript
{
  "user": "pguser", 
  "database": "haraka",
  "password": "",
  "host": "127.0.0.1",
  "port": 5432,
  "max": 20,
  "idleTimeoutMillis": 30000,
  "default_domain": "example.com",
  "profiles_query": "SELECT * FROM profile",
  "users_query": "SELECT * FROM \"user\""
}
```

### Profile table

Populate your profiles this way :
* name : for log readability
* desc : description, no use actually
* rcpt : comma separated list of emails this profile can send mail to (optional)
* rcpt_re : comma separated list of regexp to check emails addresses this profile can send mail to (optional)
* host : comma separated list of domains this profile can send mail to (optional)
* open : true means no restriction

### User table

Populate your users this way :
* user : username used for SMTP authentication
* password : SHA512 encoded password for SMTP authentication (see auth-enc-file plugin)
* profile : profile id this user belongs to
* froms : comma separated list of emails addresses this user can user for envelope MAIL FROM

All profiles and users are fetched at startup and kept in memory.