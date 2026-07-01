import { glob } from "glob";
import fs from "fs";
import path from "path";
import { parseArgs } from "node:util";
import { extractFile } from "./utils/ts-extract-utils";
import type { Card, SupportedLanguages } from "../interfaces";

type ImageAssetInfo = {
	[lang: string]: {
		[seriesId: string]: {
			[setId: string]: { [cardId: string]: string };
		};
	};
};

/**
 * Run with: bun scripts/findRelatedCards.ts
 */

async function main({
	filePatterns = undefined,
	category = ["Pokemon", "Trainer", "Energy"],
	imageLinks = false,
	imageQuality = "high",
	imageExtension = "png",
	outputJson = false,
}: {
	filePatterns?: string[];
	category?: ("Pokemon" | "Trainer" | "Energy")[];
	imageLinks?: boolean;
	imageQuality?: "high" | "low";
	imageExtension?: "png" | "webp" | "jpg";
	outputJson?: boolean;
}) {
	if (filePatterns === undefined || filePatterns.length === 0) {
		console.error("No file patterns provided!");
		process.exit(1);
	}

	// load image asset links (do this first to abort early if network issues)
	let imagesData: ImageAssetInfo | undefined = undefined;
	if (imageLinks) {
		const url = "https://assets.tcgdex.net/datas.json";
		log(`Loading image assets information from ${url} ...`);
		const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
		imagesData = await resp.json();
	}

	// global total card lookup (card hash key -> list of card file paths)
	const cardLookup: Map<string, string[]> = new Map();

	// process each file pattern (and output statistics separately) but combine card lookup
	for (const filePattern of filePatterns) {
		// get card file paths
		const files = await glob(filePattern);
		if (files.length === 0) {
			log(`No files found matching pattern: ${filePattern}`);
			process.exit(0);
		}
		// files.sort() // doesn't really matter and is not really card order anyway
		log(`Found ${files.length} files for pattern "${filePattern}"`);

		// stats
		const errorFiles: string[] = [];
		const noIllustratorFiles: string[] = [];
		const excludedCategory: string[] = [];

		for (const filePath of files) {
			// same as `check-missing.ts`, but likely doesn't even matter?
			const relativePath = path.relative(process.cwd(), filePath);

			// Extract the default export
			const exportedObject = extractFile(filePath);

			// if nothing, error
			if (!exportedObject) {
				log(`❌ ${relativePath} - Could not extract default export`);
				errorFiles.push(relativePath);
				continue;
			}
			// custom filter
			if (!category.includes(exportedObject.category)) {
				excludedCategory.push(relativePath);
				continue;
			}
			// illustrator is quite important for our metadata hash, so assert
			if (exportedObject.illustrator === undefined) {
				log(`❌ ${relativePath} - Does not have illustrator, so skip`);
				noIllustratorFiles.push(relativePath);
				continue;
			}

			// TODO: maybe check for existing `.related: [{}]`

			const key = keyForCard(filePath, exportedObject);
			const value = filePath;
			if (!cardLookup.has(key)) cardLookup.set(key, []);
			cardLookup.get(key)!.push(value);
		}

		// stats
		log(
			`Parse errors:\t\t  ${((errorFiles.length / files.length) * 100).toFixed(2)}% (${errorFiles.length})`,
		);
		log(
			`No illustrators:\t  ${((noIllustratorFiles.length / files.length) * 100).toFixed(2)}% (${noIllustratorFiles.length})`,
		);
		log(
			`Wrong category:\t\t  ${((excludedCategory.length / files.length) * 100).toFixed(2)}% (${excludedCategory.length})`,
		);
		log("-".repeat(40));
	}

	// filter for hashes with multiple entries (possible mappings)
	let cardLookupMultiples = new Map<string, string[]>(
		Array.from(cardLookup.entries()).filter(
			([, filePath]) => filePath.length > 1,
		),
	);

	log(`Unique keys (total):\t  ${cardLookup.size}`);
	log(
		`Possible mappings:\t  ${((cardLookupMultiples.size / cardLookup.size) * 100).toFixed(2)}% (${cardLookupMultiples.size})`,
	);

	// if we want to have image asset links, filter again to only keep those
	let lookupFilePath2URL: Map<string, string | undefined> | undefined =
		undefined;
	if (imagesData !== undefined) {
		log(`Filter mappings by requiring valid image assets...`);

		// try to get card images for each path
		lookupFilePath2URL = new Map<string, string | undefined>(
			await Promise.all(
				Array.from(cardLookupMultiples.values())
					.flat(1)
					.map(async (filePath) => {
						const url = await assertUrlForFilePath(
							filePath,
							imagesData,
						);
						return [filePath, url] as const;
					}),
			),
		);

		// now filter hashes and path lists for those that have valid image urls
		for (const key of cardLookupMultiples.keys()) {
			const paths = cardLookupMultiples.get(key)!;
			const validPaths = paths.filter(
				(path) => lookupFilePath2URL?.get(path) !== undefined,
			);
			if (!validPaths || validPaths.length <= 1) {
				cardLookupMultiples.delete(key);
			} else {
				cardLookupMultiples.set(key, validPaths);
			}
		}

		log(
			`Possible mappings:\t  ${((cardLookupMultiples.size / cardLookup.size) * 100).toFixed(2)}% (${cardLookupMultiples.size})`,
		);
	}

	if (outputJson) {
		// output structured JSON

		// pre-compute serie/set/card ids for given path
		const lookupIdsInfo: Map<String, { [key: string]: string }> = new Map(
			await Promise.all(
				Array.from(cardLookupMultiples.values())
					.flat(1)
					.map(async (path) => {
						const [cardId, card] = await loadCard(path);
						const lang = getLang(card);
						return [
							path,
							{
								cardId,
								setId: card.set.id,
								serieId: card.set.serie.id,
								lang,
							},
						] as const;
					}),
			),
		);

		// build JSON
		const result = Object.fromEntries(
			Array.from(cardLookupMultiples.entries()).map(([key, paths]) => [
				key,
				paths.map((path) => {
					const info = { path };
					// add image URL
					if (lookupFilePath2URL !== undefined) {
						const assetUrl = lookupFilePath2URL.get(path);
						const url = `${assetUrl}/${imageQuality}.${imageExtension}`;
						Object.assign(info, { url });
					}
					// add ids
					const idsInfo = lookupIdsInfo.get(path);
					if (idsInfo !== undefined) Object.assign(info, idsInfo);
					return info;
				}),
			]),
		);
		// console.log() without `JSON.stringify` auto-formats but is not completely valid JSON
		console.log(JSON.stringify(result, undefined, 2));
	} else {
		// output results
		for (const [key, paths] of cardLookupMultiples.entries()) {
			log(`✅ ${key}`);
			for (const path of paths) {
				log(`\t🎴 ${path}`);
				if (lookupFilePath2URL !== undefined) {
					const assetUrl = lookupFilePath2URL.get(path);
					const url = `${assetUrl}/${imageQuality}.${imageExtension}`;
					log(`\t   ⤷ 🖼️ ${url}`);
				}
			}
		}
	}

	// Write output file if specified
	writeLog();
}

async function loadCard(filePath: string) {
	const cardFilename = path.basename(filePath);
	const cardId = cardFilename.slice(0, -path.extname(cardFilename).length);
	// load full card to automatically get the set information
	const card = (await import(`../${filePath}`)).default as Card;
	return [cardId, card] as const;
}

function getLang(card: Card) {
	// assume some default language based on name usage

	// TODO: not completely fool-proof for some language specific variants, I guess?
	const lang =
		card.name["en"] !== undefined
			? "en"
			: card.name["ja"] !== undefined
				? "ja"
				: (Object.keys(card.name)[0] ?? "en");
	return lang as SupportedLanguages;
}

async function assertUrlForFilePath(
	filePath: string,
	imagesData: ImageAssetInfo,
) {
	// load full card to automatically get the set information
	const [cardId, card] = await loadCard(filePath);
	// assume some default language for card
	const lang = getLang(card);

	// try to check card image
	// see: cardUtil.ts#getCardPictures
	const fileExists = Boolean(
		imagesData?.[lang]?.[card.set.serie.id]?.[card.set.id]?.[cardId],
	);
	const url = fileExists
		? `https://assets.tcgdex.net/${lang}/${card.set.serie.id}/${card.set.id}/${cardId}`
		: undefined;
	return url;
}

function keyForCard(filePath: string, card: Exclude<Card, "set">) {
	const keyBase = `${card.illustrator}:${card.category}:${card.rarity ?? "?"}`;
	let key = `${keyBase}:?`;
	switch (card.category) {
		case "Trainer":
			key = `${keyBase}:${card.trainerType}`;
			break;
		case "Energy":
			// NOTE: most cards do NOT have an illustrator
			// see: https://limitlesstcg.com/cards?q=type%3Aenergy
			key = `${keyBase}:${card.energyType}`;
			break;
		case "Pokemon":
			const keyInfo = `${card.stage}:${card.hp}`; // + dexId?
			const keyTypes = `${card.types?.join("+") ?? "-"}:${card.weaknesses?.map((w) => w.type).join("+") ?? "-"}:${card.resistances?.map((r) => r.type).join("+") ?? "-"}`;
			const keyAttack = `${card.attacks?.map((a) => (a.cost?.join("+") ?? "") + (a.damage ?? 0))}:${card.retreat ?? 0}`;
			key = `${keyBase}:${keyInfo}:${keyTypes}:${keyAttack}`;
			break;
		default:
			log(
				`Unknown card category: '${card.category}' for file ${filePath}`,
			);
			break;
	}
	return key;
}

// -------------------------------------------------------------------------

const outputLines: string[] = [];
let outputFile: string | undefined = undefined;
let silent: boolean = false;

function log(message: string) {
	if (!silent) console.log(message);

	if (outputFile) {
		outputLines.push(message);
	}
}

function writeLog() {
	if (outputFile) {
		try {
			fs.writeFileSync(outputFile, outputLines.join("\n"));
			if (!silent) console.log(`\n📝 Results written to: ${outputFile}`);
		} catch (error) {
			console.error(
				`Error writing to ${outputFile}:`,
				(error as Error).message,
			);
		}
	}
}

// -------------------------------------------------------------------------

// Get CLI arguments
const { values, positionals } = parseArgs({
	// args: process.argv.slice(2),
	options: {
		help: {
			type: "boolean",
			short: "h",
		},
		logs: {
			type: "string",
			short: "l",
		},
		category: {
			type: "string",
			short: "c",
			multiple: true,
		},
		images: {
			type: "boolean",
			short: "i",
		},
		json: {
			type: "boolean",
		},
	},
	allowPositionals: true,
});

if (values["help"] === true || positionals.length === 0) {
	console.error(
		"Usage: bun findRelatedCards.ts <file-pattern>... [-c|--category Pokemon] [-c|--category Trainer] [-c|--category Energy] [-i|--images] [--json] [-l|--logs output-file]",
	);
	console.error("Example: bun findRelatedCards.ts --help");
	console.error('Example: bun findRelatedCards.ts "data/*/*/*.ts"');
	console.error(
		'Example: bun findRelatedCards.ts "data/*/*/*.ts" -c Pokemon -c Trainer',
	);
	console.error(
		'Example: bun findRelatedCards.ts "data/Mega*/*/*.ts" -c Pokemon -i',
	);
	console.error(
		'Example: bun findRelatedCards.ts "data/Mega*/*/*.ts" -c Pokemon -i --json',
	);
	console.error(
		'Example: bun findRelatedCards.ts "data/*/*/*.ts" "data-asia/*/*/*.ts" --logs "report.txt"',
	);
	console.error(
		"Info: script to check for same cards across language/series/sets (primarily based on illustrator), uses a metadata hash for each cards for grouping",
	);
	process.exit(1);
}

outputFile = values["logs"] as string | undefined;
silent = values["json"] === true;

main({
	filePatterns: positionals,
	category: values["category"] as
		| ("Pokemon" | "Trainer" | "Energy")[]
		| undefined,
	imageLinks: values["images"],
	outputJson: values["json"],
}).catch((error) => {
	console.error("[x] Fatal error:", error);
	process.exit(1);
});

// NOTE: include imagehash to further validate matches

// observation (1): should be the same but is quite different, is that the same card or not?
// ✅ 5ban Graphics:Pokemon:Rare:Basic:130:Lightning:Fighting:-:Colorless+Colorless20,Lightning+Lightning+Colorless120:2
//    🎴 data/Black & White/Next Destinies/50.ts
//       ⤷ 🖼️ https://assets.tcgdex.net/en/bw/bw4/50/high.png
//    🎴 data/Black & White/Black & White/47.ts
//       ⤷ 🖼️ https://assets.tcgdex.net/en/bw/bw1/47/high.png
//    🎴 data/Black & White/BW Black Star Promos/BW24.ts
//       ⤷ 🖼️ https://assets.tcgdex.net/en/bw/bwp/BW24/high.png
// observation (2): most energy cards do not have an illustrator
// observation (3): most trainer cards are hard to map, maybe by name but that would only work for the same language!
