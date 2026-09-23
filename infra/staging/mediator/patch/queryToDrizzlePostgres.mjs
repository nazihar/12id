import { CredoDrizzleStorageError } from "../error/CredoDrizzleStorageError.mjs";
import "../error/index.mjs";
import "../postgres/index.mjs";
import { BaseRecord } from "@credo-ts/core";
import { and, eq, not, or, param, sql } from "drizzle-orm";
import { PgColumn, pgTable } from "drizzle-orm/pg-core";

//#region src/adapter/queryToDrizzlePostgres.ts
/**
* Checks if a PostgreSQL array column contains all values from the given array
*
* @param column The array column to check
* @param values Array of values that should be contained in the column
* @returns SQL condition that checks if all values are in the array column
*/
function arrayContainsAll(column, values) {
	if (values.length === 0) return sql`true`;
	// 12id patch (Phase 7 review M18): native containment on jsonb and array columns, so a GIN index
	// (infra/staging/mediator/indexes.sql) can serve it. The upstream `to_jsonb(column) @> ...` means
	// the same thing but can never use an index (to_jsonb is STABLE, not IMMUTABLE), which made the
	// recipient-key lookup of every inbound message a full scan of "Did". The column encodes the
	// values exactly as it stores them (a JSON array for jsonb, an array literal for arrays).
	if (column.columnType === "PgJsonb" || column.columnType === "PgArray") return sql`${column} @> ${param(values, column)}`;
	return sql`to_jsonb(${column}) @> to_jsonb(array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}])`;
}
/**
* Checks if a JSONB array contains all values from a given array
*
* @param column The JSON/JSONB column to access
* @param paths Path segments to the JSON array property
* @param values Array of values to check for containment
* @returns SQL condition that checks if all values are contained in the array
*/
function jsonArrayContainsAll(column, field, values) {
	if (values.length === 0) return sql`true`;
	const path = sql`to_jsonb(${column})->'${sql.raw(field)}'`;
	const conditions = values.map((value) => {
		return sql`${path} @> ${sql`'[${sql.raw(JSON.stringify(value))}]'::jsonb`}`;
	});
	return sql.join(conditions, sql` AND `);
}
function jsonEqual(column, field, value) {
	const valueType = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "numeric" : "text";
	return sql`(${column} ->> '${sql.raw(field)}')::${sql.raw(valueType)} = ${value}`;
}
/**
* Converts a WQL object to Drizzle where conditions
*/
function queryToDrizzlePostgres(query, table, customTagKeyMapping) {
	if (!query || Object.keys(query).length === 0) return sql`true`;
	const conditions = [];
	if (query.$or && Array.isArray(query.$or) && query.$or.length > 0) {
		const _$or = query.$or;
		const orCondition = or(..._$or.map((or$1) => queryToDrizzlePostgres(or$1, table, customTagKeyMapping)).filter((sql$1) => sql$1 !== void 0));
		if (orCondition) conditions.push(orCondition);
	}
	if (query.$and && Array.isArray(query.$and) && query.$and.length > 0) {
		const _$and = query.$and;
		const andCondition = and(..._$and.map((and$1) => queryToDrizzlePostgres(and$1, table, customTagKeyMapping)).filter((sql$1) => sql$1 !== void 0));
		if (andCondition) conditions.push(andCondition);
	}
	if (query.$not) {
		const notQuery = query.$not;
		const notConditions = [];
		if (notQuery.$and && Array.isArray(notQuery.$and) && notQuery.$and.length > 0) {
			const andCondition = and(...notQuery.$and.map((andItem) => {
				const condition = queryToDrizzlePostgres(andItem, table, customTagKeyMapping);
				return condition ? not(condition) : void 0;
			}).filter((condition) => condition !== void 0));
			if (andCondition) notConditions.push(andCondition);
		}
		if (notQuery.$or && Array.isArray(notQuery.$or) && notQuery.$or.length > 0) {
			const _$or = notQuery.$or;
			const orCondition = and(..._$or.map((orItem) => queryToDrizzlePostgres(orItem, table, customTagKeyMapping)).filter(Boolean));
			if (orCondition) notConditions.push(not(orCondition));
		}
		for (const field in notQuery) {
			if (field === "$not") throw new Error("Nested $not in $not is not supported");
			if (field === "$or" || field === "$and") continue;
			const condition = queryToDrizzlePostgres({ [field]: notQuery[field] }, table, customTagKeyMapping);
			if (condition) notConditions.push(not(condition));
		}
		const combinedNotCondition = notConditions.length === 1 ? notConditions[0] : and(...notConditions);
		if (combinedNotCondition) conditions.push(combinedNotCondition);
	}
	for (const field in query) {
		if (field === "$or" || field === "$and" || field === "$not") continue;
		const value = query[field];
		if (value === void 0) continue;
		if (field in table && table[field] instanceof PgColumn) {
			const column = table[field];
			if (Array.isArray(value)) conditions.push(arrayContainsAll(column, value));
			else conditions.push(eq(column, value));
		} else {
			let targetField = field;
			let targetColumn = table.customTags;
			if (customTagKeyMapping && field in customTagKeyMapping) {
				const [columnName, fieldName] = customTagKeyMapping[field];
				if (columnName in table && table[columnName] instanceof PgColumn) {
					targetColumn = table[columnName];
					targetField = fieldName;
				} else throw new CredoDrizzleStorageError(`Query defined custom mapping from key '${field}' to column ${columnName}, but the column does not exist in the table.`);
			}
			if (Array.isArray(value)) conditions.push(jsonArrayContainsAll(targetColumn, targetField, value));
			else conditions.push(jsonEqual(targetColumn, targetField, value));
		}
	}
	return conditions.length === 1 ? conditions[0].getSQL() : and(...conditions) ?? sql`true`;
}

//#endregion
export { queryToDrizzlePostgres };
//# sourceMappingURL=queryToDrizzlePostgres.mjs.map