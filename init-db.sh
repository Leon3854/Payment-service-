#!/bin/bash
# init-db.sh
# для инициализации баз данных
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE auth_db;
    CREATE DATABASE product_db;
    CREATE DATABASE payment_db;
    
    GRANT ALL PRIVILEGES ON DATABASE auth_db TO $POSTGRES_USER;
    GRANT ALL PRIVILEGES ON DATABASE product_db TO $POSTGRES_USER;
    GRANT ALL PRIVILEGES ON DATABASE payment_db TO $POSTGRES_USER;
    
    \c auth_db
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    
    \c product_db
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    
    \c payment_db
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
EOSQL

echo "Databases created successfully!"