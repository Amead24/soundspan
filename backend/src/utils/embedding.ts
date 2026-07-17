/**
 * Parse a pgvector embedding from its text representation "[0.1,0.2,...]"
 * into a number array.
 */
export function parseEmbedding(text: string): number[] {
    if (typeof text !== "string" || text.trim() === "") {
        throw new Error("Invalid embedding: expected non-empty string");
    }

    const values = text
        .trim()
        .split("[")
        .join("")
        .split("]")
        .join("")
        .split(",")
        .map((value: string) => value.trim());

    if (values.length === 0 || values.some((value: string) => value === "")) {
        throw new Error("Invalid embedding: contains non-numeric values");
    }

    const numbers = values.map((value: string) => Number(value));

    if (numbers.some((value: number) => !Number.isFinite(value))) {
        throw new Error("Invalid embedding: contains non-numeric values");
    }

    return numbers;
}

/**
 * Serialize an embedding for interpolation into a `${...}::vector` SQL
 * parameter as pgvector's text form "[0.1,0.2,...]".
 *
 * NEVER pass a raw number[] into those interpolations: under the Prisma 7
 * pg driver adapter a JS array is bound as a Postgres ARRAY text literal
 * ("{\"0.1\",...}"), which `::vector` rejects with 22P02 "invalid input
 * syntax for type vector". (The old Rust engine bound it as a typed float8[]
 * that pgvector could cast, which is how the raw-array form ever worked —
 * the adapter migration silently broke every such site.)
 */
export function toVectorLiteral(embedding: number[]): string {
    return `[${embedding.join(",")}]`;
}
