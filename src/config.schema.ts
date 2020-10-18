/**
 * An explanation about the purpose of this instance.
 */
/**
 * An explanation about the purpose of this instance.
 */
export type databases = "bigQuery" | "postgresql" | "mysql" | "snowflake";

/**
 * The variable will not be shown to the user if the parent variable is not set.
 */

export interface UnknownMap {
    [k: string]: unknown;
}

/**
 * The config schema that defines the recipe information and settings.
 */
export interface Config {
    /**
     * The version information of the recipe
     */
    version?: number;
    /**
     * The label of the recipe that will be shown to the user
     */
    label: string;
    dependencies?: {
        dbt?: {
            cronjob?: string;
            packages?: unknown[];
            dbtProject?: unknown[];
            [k: string]: unknown;
        };
        [k: string]: unknown;
    };
    /**
     * The explanation of what this recipe is about
     */
    description?: string;
    image?: string;
    tags?: [string, ...string[]];
    databases?: [databases, ...databases[]];
    variables?: {
        [variableName: string]: {
            /**
             * The label will be shown to the user
             */
            label?: string;
            /**
             * The type will be
             */
            type:
                | "schema"
                | "target"
                | "choice"
                | "string"
                | "numeric"
                | "boolean"
                | "model-mapping"
                | "dimension"
                | "sql"
                | "model"
                | "measure"
                | "table"
                | "multiple-table"
                | "table-column"
                | "table-multiple-column";
            options?: UnknownMap;
            default?: unknown;
            required?: boolean;
            /**
             * The explanation of the variable that will be shown to the user
             */
            description?: string;
            parent?: string;
        };
    };
}

const config: Config = {
    version: 1.1,
    label: 'Rakam API',
    description: 'It automatically creates models from your collections.',
    variables: {
        target: {
            label: 'Events Table',
            type: 'table',
            default: {table: 'EVENTS'},
        },
        event_schema: {
            type: 'sql',
            parent: 'target',
            description: 'The event schema in your Snowflake Warehouse',
            options: {
                sql: `
                SELECT EVENT_NAME as "n", ANY_VALUE(EVENT_DB) as "db", ARRAY_AGG(OBJECT_CONSTRUCT('db', PROP_DB, 'n', PROP_NAME, 't', TYPE)) as "props"
                FROM (
                    SELECT
                DISTINCT E.EVENT_TYPE as EVENT_DB,
                    LOWER(LTRIM(REGEXP_REPLACE(REGEXP_REPLACE(E.EVENT_TYPE, '([a-z])([A-Z])', '\1_\2'), '[^a-zA-Z0-9_]', ''), '_')) as EVENT_NAME,
                    F.KEY as PROP_DB,
                    LOWER(LTRIM(REGEXP_REPLACE(REGEXP_REPLACE(F.KEY, '([a-z])([A-Z])', '\1_\2'), '[^a-zA-Z0-9_]', ''), '_')) as PROP_NAME,
                    MODE(TYPEOF(f.VALUE)) OVER (PARTITION BY EVENT_DB, PROP_DB, TYPEOF(f.VALUE)) as TYPE
                FROM
                (select * from events where _TIME between DATEADD(DAY, -15, current_timestamp) and current_timestamp limit 2000000) E,
                    LATERAL FLATTEN(PROPERTIES, RECURSIVE=>FALSE) F
                WHERE
                
                TYPEOF(F.VALUE) IN ('BOOLEAN', 'DECIMAL', 'DOUBLE', 'INTEGER', 'VARCHAR')
                --AND REGEXP_LIKE(F.KEY, '^[a-zA-Z0-9]*$')
                AND EVENT_TYPE NOT IN ('$invalid_schema', '$identify')
                ) d
                GROUP BY 1`,
            },
        },
    },
    tags: ['event-analytics'],
    databases: ['snowflake'],
}
