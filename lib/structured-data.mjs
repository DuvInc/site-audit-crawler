// The structured data catalogue: which schema.org types a site uses, their fields, what Google
// requires for its results, how to write each value, a builder and a validator. One source for this
// tool's checks and for the products built on it (a schema generator, a per-template plan), so a rule
// changes once. No Node import: it runs in a browser, a Worker or Node.
//
// Sources, read 2026-11-27: Google Search Central's structured data pages (search gallery, general
// guidelines, LocalBusiness, Organization, site names, Article, Product snippet and merchant listing,
// Event, Breadcrumb, Software app, Review snippet, Profile page) and schema.org. Levels:
//   required     Google requires it for its result (or schema.org cannot mean anything without it)
//   recommended  Google recommends it, or it is what makes the node useful
//   optional     schema.org only: no Google feature, worth it when true
// Valid schema.org is not the same as eligible for a Google result: the validator keeps them apart.

export const CATALOGUE_VERSION = '2026-11-27';

/** The most common subtypes, for a picker. Any schema.org subtype is accepted by the validator. */
export const LOCAL_BUSINESS_SUBTYPES = [
  'LocalBusiness', 'Restaurant', 'Bakery', 'CafeOrCoffeeShop', 'BarOrPub', 'FastFoodRestaurant', 'IceCreamShop',
  'Store', 'ClothingStore', 'Florist', 'BookStore', 'HardwareStore', 'FurnitureStore', 'JewelryStore', 'GroceryStore',
  'HairSalon', 'BeautySalon', 'NailSalon', 'DaySpa', 'HealthClub', 'ExerciseGym', 'Dentist', 'Physician',
  'Optician', 'Pharmacy', 'VeterinaryCare', 'Attorney', 'Notary', 'AccountingService', 'InsuranceAgency',
  'RealEstateAgent', 'Plumber', 'Electrician', 'HVACBusiness', 'RoofingContractor', 'GeneralContractor',
  'HousePainter', 'Locksmith', 'MovingCompany', 'AutoRepair', 'AutoDealer', 'Hotel', 'BedAndBreakfast',
  'TravelAgency', 'ChildCare', 'Library', 'ProfessionalService', 'HomeAndConstructionBusiness',
];

export const ORGANIZATION_SUBTYPES = [
  'Organization', 'Corporation', 'OnlineStore', 'OnlineBusiness', 'NGO', 'EducationalOrganization',
  'NewsMediaOrganization', 'ResearchOrganization', 'SportsOrganization', 'PerformingGroup', 'MedicalOrganization',
];

/** Types that are not places: hours and a map belong to places (LocalBusiness and its subtypes). */
export const NOT_A_PLACE = new Set([
  'Person', ...ORGANIZATION_SUBTYPES, 'GovernmentOrganization', 'MusicGroup', 'TheaterGroup', 'DanceGroup', 'Consortium',
  'Project', 'FundingScheme', 'WorkersUnion', 'PoliticalParty', 'Cooperative', 'LibrarySystem', 'Airline',
]);

/** Types Google no longer turns into a result. Valid, harmless, earns nothing in Google. */
export const RETIRED_IN_GOOGLE = {
  FAQPage: 'FAQ results left Google Search on 2026-05-07',
  HowTo: 'HowTo results left Google Search in 2023',
};

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const AVAILABILITY = ['InStock', 'OutOfStock', 'PreOrder', 'BackOrder', 'LimitedAvailability', 'OnlineOnly', 'InStoreOnly', 'SoldOut', 'Discontinued'];
const EVENT_STATUS = ['EventScheduled', 'EventCancelled', 'EventPostponed', 'EventRescheduled', 'EventMovedOnline'];
// Google's list of supported app types (software-app page, read 2026-11-27): any other value is not read.
const APP_CATEGORIES = ['BusinessApplication', 'UtilitiesApplication', 'DeveloperApplication', 'DesignApplication', 'EducationalApplication', 'FinanceApplication', 'HealthApplication', 'LifestyleApplication', 'MultimediaApplication', 'ReferenceApplication', 'ShoppingApplication', 'TravelApplication', 'GameApplication', 'SecurityApplication', 'CommunicationApplication', 'EntertainmentApplication', 'SocialNetworkingApplication', 'SportsApplication', 'DriverApplication', 'BrowserApplication', 'DesktopEnhancementApplication', 'HomeApplication'];
const EMPLOYMENT = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER'];

const f = (key, level, kind, hint, extra = {}) => ({ key, level, kind, hint, ...extra });

const ADDRESS = (level) => [
  f('address.streetAddress', level, 'text', 'Street and number, as on the shop front and the Google Business Profile.'),
  f('address.postalCode', level, 'text', 'The postal code.'),
  f('address.addressLocality', level, 'text', 'The town or city.'),
  f('address.addressRegion', 'optional', 'text', 'The region or state, where addresses use one.'),
  f('address.addressCountry', level, 'country', 'Two letters, ISO 3166-1: DE, FR, US.'),
];

const IDENTITY_COMMON = [
  f('url', 'recommended', 'url', 'The home page, or the page of this location for a chain.'),
  f('description', 'recommended', 'longtext', 'One or two sentences: what you do, for whom, where. The same facts as the page.'),
  f('telephone', 'recommended', 'phone', 'The number customers call, with the country code: +49 30 1234567.'),
  f('email', 'recommended', 'email', 'A real inbox shown on the site.'),
  f('image', 'recommended', 'url', 'A photo of the place or the work, not the logo.'),
  f('sameAs', 'recommended', 'urls', 'Profiles that really are this business: Google Business Profile, Instagram, Facebook, LinkedIn, Wikidata.'),
];

/**
 * The types, by what an owner would call them. `fields` in the order a form shows them; `rich`
 * names the Google feature and its page, or null when the type earns no Google result.
 */
export const TYPES = {
  LocalBusiness: {
    label: 'A shop, a practice or a trade',
    subtypes: LOCAL_BUSINESS_SUBTYPES,
    rich: { feature: 'Local business details', url: 'https://developers.google.com/search/docs/appearance/structured-data/local-business' },
    place: 'home or contact page, and each location page',
    fields: [
      f('name', 'required', 'text', 'The name on the shop front and the Business Profile, exactly. No keywords added.'),
      ...ADDRESS('required'),
      ...IDENTITY_COMMON,
      f('logo', 'optional', 'url', 'Square-ish, at least 112 by 112 pixels, readable on white.'),
      f('openingHoursSpecification', 'recommended', 'hours', 'The same hours as the Business Profile, one line per range of days.'),
      f('geo.latitude', 'recommended', 'coordinate', 'At least 5 decimals: 52.52001.'),
      f('geo.longitude', 'recommended', 'coordinate', 'At least 5 decimals: 13.40495.'),
      f('priceRange', 'recommended', 'priceRange', 'Under 100 characters: €€ or €10-25.'),
      f('servesCuisine', 'recommended', 'text', 'For a restaurant: the cuisine in plain words.', { onlyFor: ['Restaurant', 'Bakery', 'CafeOrCoffeeShop', 'BarOrPub', 'FastFoodRestaurant', 'IceCreamShop'] }),
      f('menu', 'recommended', 'url', 'For a restaurant: the menu page.', { onlyFor: ['Restaurant', 'CafeOrCoffeeShop', 'BarOrPub', 'FastFoodRestaurant'] }),
      f('areaServed', 'optional', 'text', 'Towns or regions you serve, for a trade that travels.'),
      f('vatID', 'optional', 'text', 'Your VAT number, as in your legal notice.'),
    ],
  },
  Organization: {
    label: 'A company or an association',
    subtypes: ORGANIZATION_SUBTYPES,
    rich: { feature: 'Logo and details in knowledge panels', url: 'https://developers.google.com/search/docs/appearance/structured-data/organization' },
    place: 'home page or about page',
    fields: [
      f('name', 'required', 'text', 'The name people know you by.'),
      f('legalName', 'optional', 'text', 'The registered name, if different.'),
      f('alternateName', 'optional', 'text', 'Another common name or an acronym.'),
      f('logo', 'recommended', 'url', 'Square-ish, at least 112 by 112 pixels, readable on white.'),
      ...IDENTITY_COMMON.filter((x) => x.key !== 'image'),
      ...ADDRESS('recommended'),
      f('foundingDate', 'optional', 'date', 'The year or date it was founded: 2019 or 2019-04-01.'),
      f('vatID', 'recommended', 'text', 'Your VAT number: a trust signal in the EU.'),
    ],
  },
  Person: {
    label: 'Me, working under my own name',
    rich: null,
    place: 'home page or about page',
    fields: [
      f('name', 'required', 'text', 'Your name as clients know it.'),
      f('jobTitle', 'recommended', 'text', 'What you do, in plain words: Wedding photographer.'),
      f('url', 'recommended', 'url', 'Your home page.'),
      f('image', 'recommended', 'url', 'A portrait.'),
      f('description', 'recommended', 'longtext', 'One or two sentences about your work.'),
      f('email', 'optional', 'email', 'An inbox shown on the site.'),
      f('telephone', 'optional', 'phone', 'With the country code.'),
      f('sameAs', 'recommended', 'urls', 'Your profiles: LinkedIn, Instagram, Behance, Wikidata.'),
      f('worksFor.name', 'optional', 'text', 'Your company, if you have one.'),
    ],
  },
  WebSite: {
    label: "My website's name",
    rich: { feature: 'Site name above the results', url: 'https://developers.google.com/search/docs/appearance/site-names' },
    place: 'home page at the root of the domain only',
    fields: [
      f('name', 'required', 'text', 'The name Google should show above your results: short, your brand.'),
      f('url', 'required', 'url', 'Your home page, at the root of the domain.'),
      f('alternateName', 'recommended', 'text', 'An acronym or another spelling people use.'),
      f('inLanguage', 'optional', 'text', 'The language of the site: en, fr, de.'),
    ],
  },
  Product: {
    label: 'A product',
    rich: { feature: 'Product snippet: price, availability', url: 'https://developers.google.com/search/docs/appearance/structured-data/product-snippet' },
    place: 'each product page',
    fields: [
      f('name', 'required', 'text', 'The product name as shown on the page.'),
      f('image', 'recommended', 'url', 'A product photo. Required to appear in merchant listings.'),
      f('description', 'recommended', 'longtext', 'The description shown on the page.'),
      f('brand.name', 'recommended', 'text', 'The brand.'),
      f('sku', 'optional', 'text', 'Your reference.'),
      f('gtin', 'optional', 'text', 'The barcode number, when the product has one.'),
      f('offers.price', 'required', 'price', 'The price shown, as a number: 24.90. Google needs a price, a review or a rating; never invent the last two.'),
      f('offers.priceCurrency', 'required', 'currency', 'Three letters, ISO 4217: EUR, USD.'),
      f('offers.availability', 'recommended', 'enum', 'Whether it can be bought now.', { values: AVAILABILITY }),
      f('offers.url', 'optional', 'url', 'The page where it is bought.'),
    ],
  },
  Service: {
    label: 'A service',
    rich: null,
    place: 'each service page',
    fields: [
      f('name', 'required', 'text', 'The service as named on the page.'),
      f('description', 'recommended', 'longtext', 'What it includes and for whom.'),
      f('serviceType', 'optional', 'text', 'The kind of service in common words: Boiler repair.'),
      f('areaServed', 'recommended', 'text', 'Where you provide it.'),
      f('provider.name', 'recommended', 'text', 'Your business. On a site with an identity node, point at its @id instead.'),
      f('offers.price', 'optional', 'price', 'Only when a price is shown.'),
      f('offers.priceCurrency', 'optional', 'currency', 'Three letters: EUR.'),
    ],
  },
  Event: {
    label: 'An event',
    rich: { feature: 'Event listings', url: 'https://developers.google.com/search/docs/appearance/structured-data/event' },
    place: 'each event page',
    fields: [
      f('name', 'required', 'text', 'The event as named on the page.'),
      f('startDate', 'required', 'datetime', 'Date and time with the time zone: 2026-12-05T19:00+01:00.'),
      f('endDate', 'recommended', 'datetime', 'When it ends, same format.'),
      f('location.name', 'required', 'text', 'The venue. Google lists events at a venue only.'),
      ...ADDRESS('required').map((x) => ({ ...x, key: `location.${x.key}` })),
      f('eventStatus', 'recommended', 'enum', 'Scheduled, or what changed.', { values: EVENT_STATUS }),
      f('description', 'recommended', 'longtext', 'What happens there.'),
      f('image', 'recommended', 'url', 'A picture of the event.'),
      f('offers.price', 'recommended', 'price', 'The ticket price; 0 when free.'),
      f('offers.priceCurrency', 'recommended', 'currency', 'Three letters: EUR.'),
      f('offers.url', 'recommended', 'url', 'Where to book.'),
      f('organizer.name', 'recommended', 'text', 'Who organises it.'),
    ],
  },
  BlogPosting: {
    label: 'A blog post or an article',
    subtypes: ['BlogPosting', 'Article', 'NewsArticle'],
    rich: { feature: 'Article title, image and date', url: 'https://developers.google.com/search/docs/appearance/structured-data/article' },
    place: 'each post: one decision for the post template',
    fields: [
      f('headline', 'recommended', 'text', 'The visible title; short titles survive truncation.'),
      f('image', 'recommended', 'url', 'The cover, at least 50,000 pixels (width times height); not a logo.'),
      f('datePublished', 'recommended', 'datetime', 'When it was first published, with the time zone.'),
      f('dateModified', 'recommended', 'datetime', 'Only when the content changed.'),
      f('author.name', 'recommended', 'text', 'Each author by name, one author entry each; the name only: no job title, no "by", no company.'),
      f('author.url', 'recommended', 'url', 'A page about the author (their profile page on the site, marked up as ProfilePage), or their own profile elsewhere.'),
      f('description', 'optional', 'longtext', 'The meta description is fine.'),
      f('publisher.name', 'optional', 'text', 'Your business. On a site with an identity node, point at its @id instead.'),
    ],
  },
  WebApplication: {
    label: 'A free tool or a web app',
    subtypes: ['WebApplication'],
    rich: { feature: 'Software app (needs real ratings or reviews)', url: 'https://developers.google.com/search/docs/appearance/structured-data/software-app' },
    place: 'the page of each tool',
    fields: [
      f('name', 'required', 'text', 'The tool as named on its page.'),
      f('url', 'recommended', 'url', 'The page of the tool.'),
      f('description', 'recommended', 'longtext', 'What it does, in one sentence.'),
      f('applicationCategory', 'recommended', 'enum', 'The kind of app, from Google list.', { values: APP_CATEGORIES }),
      f('operatingSystem', 'recommended', 'text', 'Web, for a tool in the browser.'),
      f('offers.price', 'required', 'price', '0 for a free tool.'),
      f('offers.priceCurrency', 'recommended', 'currency', 'Three letters: EUR.'),
      f('isAccessibleForFree', 'optional', 'boolean', 'True for a free tool.'),
      f('provider.name', 'optional', 'text', 'Who makes it.'),
    ],
  },
  SoftwareApplication: {
    label: 'The software a company sells (a SaaS, an app)',
    subtypes: ['SoftwareApplication', 'MobileApplication'],
    rich: { feature: 'Software app (needs real ratings or reviews collected on the site)', url: 'https://developers.google.com/search/docs/appearance/structured-data/software-app' },
    place: 'once, on the page that presents the product and its price (the pricing page); WebApplication when it only runs in a browser',
    fields: [
      f('name', 'required', 'text', 'The product name, as on the page.'),
      f('offers.price', 'required', 'price', 'The price of the entry plan as a number; 0 when there is a free plan. One Offer per plan is better: each with its name, price and currency.'),
      f('offers.priceCurrency', 'recommended', 'currency', 'Three letters: EUR, USD.'),
      f('applicationCategory', 'recommended', 'enum', "The kind of app, from Google's list (BusinessApplication for most B2B SaaS).", { values: APP_CATEGORIES }),
      f('operatingSystem', 'recommended', 'text', 'Web for a browser app; the systems (Windows, macOS, iOS, Android) when there are apps to install.'),
      f('description', 'recommended', 'longtext', 'What it does, for whom, in one or two sentences.'),
      f('url', 'recommended', 'url', 'The product or pricing page.'),
      f('image', 'optional', 'url', 'A screenshot of the product.'),
      f('provider.name', 'optional', 'text', 'The company. On a site with an identity node, point at its @id instead.'),
    ],
  },
  TechArticle: {
    label: 'A documentation or help page',
    subtypes: ['TechArticle', 'APIReference'],
    rich: null,
    place: 'each documentation page: one decision for the docs template',
    fields: [
      f('headline', 'recommended', 'text', 'The page title as shown.'),
      f('description', 'recommended', 'longtext', 'What the page explains; the meta description is fine.'),
      f('dateModified', 'recommended', 'datetime', 'When the content last changed, with the time zone.'),
      f('image', 'optional', 'url', 'A screenshot or diagram from the page, never the logo.'),
      f('publisher.name', 'optional', 'text', 'Your company. On a site with an identity node, point at its @id instead.'),
    ],
  },
  ProfilePage: {
    label: 'A page about one person (an author, a team member)',
    rich: { feature: 'Profile details in Google (forums, authors)', url: 'https://developers.google.com/search/docs/appearance/structured-data/profile-page' },
    place: 'each author or team member page, when the page is about that person',
    fields: [
      f('mainEntity.name', 'required', 'text', 'The person\'s real name; a handle goes in alternateName.'),
      f('mainEntity.image', 'recommended', 'url', 'Their photo; no placeholder.'),
      f('mainEntity.description', 'recommended', 'longtext', 'Their bio, as on the page.'),
      f('mainEntity.sameAs', 'recommended', 'urls', 'Their own profiles: LinkedIn, X, GitHub, a personal site.'),
      f('mainEntity.jobTitle', 'optional', 'text', 'Their role, as on the page.'),
      f('dateModified', 'optional', 'datetime', 'When the profile was last edited by a person.'),
    ],
  },
  JobPosting: {
    label: 'A job offer',
    rich: { feature: 'Google for Jobs listing', url: 'https://developers.google.com/search/docs/appearance/structured-data/job-posting' },
    place: 'each open position, removed or given validThrough when it closes',
    fields: [
      f('title', 'required', 'text', 'The job title only: no company, salary or "urgent".'),
      f('description', 'required', 'longtext', 'The full description, as on the page (HTML allowed).'),
      f('datePosted', 'required', 'date', 'When it was first published.'),
      f('hiringOrganization.name', 'required', 'text', 'The employer.'),
      f('jobLocation.address.addressLocality', 'required', 'text', 'The town of the workplace. A fully remote job uses jobLocationType instead.'),
      f('jobLocation.address.addressCountry', 'required', 'country', 'Two letters: DE, FR.'),
      f('validThrough', 'recommended', 'datetime', 'When applications close.'),
      f('employmentType', 'recommended', 'enum', 'FULL_TIME, PART_TIME, CONTRACTOR…', { values: EMPLOYMENT }),
      f('jobLocationType', 'recommended', 'text', 'TELECOMMUTE for a remote job, with applicantLocationRequirements.'),
      f('applicantLocationRequirements.name', 'recommended', 'text', 'For a remote job: the country where the person may live.'),
      f('baseSalary.value.value', 'recommended', 'price', 'The salary when the page shows it, as a number.'),
      f('baseSalary.currency', 'recommended', 'currency', 'Its currency: EUR.'),
      f('directApply', 'optional', 'boolean', 'True when the page itself takes the application.'),
    ],
  },
  VideoObject: {
    label: 'A video',
    rich: { feature: 'Video in results', url: 'https://developers.google.com/search/docs/appearance/structured-data/video' },
    place: 'the page whose main content is the video',
    fields: [
      f('name', 'required', 'text', 'The video title.'),
      f('thumbnailUrl', 'required', 'url', 'Its thumbnail image.'),
      f('uploadDate', 'required', 'datetime', 'When it was published, with the time zone.'),
      f('description', 'recommended', 'longtext', 'What it shows.'),
      f('duration', 'recommended', 'text', 'ISO 8601: PT2M30S.'),
      f('embedUrl', 'recommended', 'url', 'The player URL (a YouTube embed), or contentUrl for the file.'),
    ],
  },
  BreadcrumbList: {
    label: 'A breadcrumb trail',
    rich: { feature: 'Breadcrumb in the result', url: 'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb' },
    place: 'every page below the home page',
    fields: [
      f('itemListElement', 'required', 'list', 'From the home page to this page, as the trail shows it.', {
        item: [f('name', 'required', 'text', 'The label as shown.', { label: 'Label' }), f('item', 'required', 'url', 'The page address; leave it out for the last step.')],
      }),
    ],
  },
  FAQPage: {
    label: 'Questions and answers',
    rich: null,
    retired: RETIRED_IN_GOOGLE.FAQPage,
    place: 'a page that shows the questions',
    fields: [
      f('mainEntity', 'required', 'list', 'Each question and its answer, as the page shows them.', {
        item: [f('name', 'required', 'text', 'The question.', { label: 'Question' }), f('acceptedAnswer.text', 'required', 'longtext', 'The answer, as plain text.')],
      }),
    ],
  },
};

/** A field's name for a person filling a form. `location.address.x` reads as `address.x`; a field may carry its own `label`. */
export const FIELD_LABELS = {
  name: 'Name', legalName: 'Legal name', alternateName: 'Other name', logo: 'Logo', url: 'Web address',
  description: 'Description', telephone: 'Phone', email: 'Email', image: 'Picture', sameAs: 'Profiles elsewhere',
  'address.streetAddress': 'Street and number', 'address.postalCode': 'Postal code', 'address.addressLocality': 'Town or city',
  'address.addressRegion': 'Region', 'address.addressCountry': 'Country code', openingHoursSpecification: 'Opening hours',
  'geo.latitude': 'Latitude', 'geo.longitude': 'Longitude', priceRange: 'Price range', servesCuisine: 'Cuisine', menu: 'Menu page',
  areaServed: 'Area served', vatID: 'VAT number', foundingDate: 'Founded', jobTitle: 'What you do', 'worksFor.name': 'Company',
  inLanguage: 'Language', 'brand.name': 'Brand', sku: 'Reference (SKU)', gtin: 'Barcode (GTIN)', 'offers.price': 'Price',
  'offers.priceCurrency': 'Currency', 'offers.availability': 'Availability', 'offers.url': 'Page to buy or book',
  serviceType: 'Kind of service', 'provider.name': 'Provided by', startDate: 'Starts', endDate: 'Ends', 'location.name': 'Venue',
  eventStatus: 'Status', 'organizer.name': 'Organiser', headline: 'Title', datePublished: 'Published', dateModified: 'Updated',
  'author.name': 'Author', 'author.url': 'Author page', 'publisher.name': 'Publisher', applicationCategory: 'Kind of app',
  operatingSystem: 'Runs on', isAccessibleForFree: 'Free to use', itemListElement: 'Steps', mainEntity: 'Questions',
  item: 'Page address', 'acceptedAnswer.text': 'Answer', 'mainEntity.name': 'Name', 'mainEntity.image': 'Photo',
  'mainEntity.description': 'Bio', 'mainEntity.sameAs': 'Profiles elsewhere', 'mainEntity.jobTitle': 'Role', title: 'Job title',
  datePosted: 'Posted', 'hiringOrganization.name': 'Employer', 'jobLocation.address.addressLocality': 'Workplace town',
  'jobLocation.address.addressCountry': 'Workplace country', validThrough: 'Closes', employmentType: 'Contract',
  jobLocationType: 'Remote', 'applicantLocationRequirements.name': 'Where applicants live', 'baseSalary.value.value': 'Salary', 'baseSalary.currency': 'Salary currency',
  directApply: 'Apply on the page', thumbnailUrl: 'Thumbnail', uploadDate: 'Published', duration: 'Duration', embedUrl: 'Player address',
};

export const labelFor = (key) => FIELD_LABELS[key] ?? FIELD_LABELS[key.replace(/^location\./, '')] ?? key;

/** Which types a page carries, by its role in the site (one decision per template, not per page). */
export const TYPES_BY_ROLE = {
  home: ['WebSite', 'identity'],
  about: ['identity'],
  contact: ['identity'],
  location: ['LocalBusiness', 'BreadcrumbList'],
  service: ['Service', 'BreadcrumbList'],
  product: ['Product', 'BreadcrumbList'],
  // A software company's product, once: where it is presented with its price.
  pricing: ['SoftwareApplication'],
  article: ['BlogPosting', 'BreadcrumbList'],
  docs: ['TechArticle', 'BreadcrumbList'],
  profile: ['ProfilePage', 'BreadcrumbList'],
  job: ['JobPosting', 'BreadcrumbList'],
  event: ['Event', 'BreadcrumbList'],
  tool: ['WebApplication', 'BreadcrumbList'],
  // Comparison and alternative pages: no Product or Review about a competitor, ever.
  comparison: ['BreadcrumbList'],
  listing: ['BreadcrumbList'],
  legal: ['BreadcrumbList'],
  other: ['BreadcrumbList'],
};

/** The catalogue entry for a type or one of its subtypes; identity types resolve by their family. */
export function entryFor(type) {
  if (TYPES[type]) return { base: type, ...TYPES[type] };
  for (const [base, entry] of Object.entries(TYPES)) if (entry.subtypes?.includes(type)) return { base, ...entry };
  if (NOT_A_PLACE.has(type)) return { base: 'Organization', ...TYPES.Organization };
  return null;
}

/** The fields that apply to one concrete type (a subtype can drop place-only or cuisine fields). */
export function fieldsFor(type) {
  const entry = entryFor(type);
  if (!entry) return [];
  return entry.fields.filter((x) => (!x.onlyFor || x.onlyFor.includes(type)) && !(NOT_A_PLACE.has(type) && ['openingHoursSpecification', 'geo.latitude', 'geo.longitude', 'priceRange'].includes(x.key)));
}

const NESTED_TYPES = {
  address: 'PostalAddress', geo: 'GeoCoordinates', offers: 'Offer', brand: 'Brand', author: 'Person',
  publisher: 'Organization', provider: 'Organization', organizer: 'Organization', location: 'Place', worksFor: 'Organization',
  mainEntity: 'Person', hiringOrganization: 'Organization', jobLocation: 'Place', applicantLocationRequirements: 'Country',
  baseSalary: 'MonetaryAmount', value: 'QuantitativeValue',
  acceptedAnswer: 'Answer',
};

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

function setDeep(target, key, value) {
  const parts = key.split('.');
  let node = target;
  parts.slice(0, -1).forEach((part) => {
    node[part] ??= NESTED_TYPES[part] ? { '@type': NESTED_TYPES[part] } : {};
    node = node[part];
  });
  node[parts.at(-1)] = value;
}

const getDeep = (node, key) => key.split('.').reduce((n, part) => (n == null ? undefined : Array.isArray(n) ? n[0]?.[part] : n[part]), node);

/**
 * JSON-LD from flat values keyed like the catalogue (`address.streetAddress`). Empty values are left
 * out. `hours` is `[{ days: ['Monday'], opens: '09:00', closes: '18:00' }]`; a `list` is an array of
 * flat item values; `urls` is an array or a newline-separated string.
 */
export function buildJsonLd(type, values) {
  const node = { '@context': 'https://schema.org', '@type': type };
  if (!blank(values['@id'])) node['@id'] = values['@id'];
  for (const field of fieldsFor(type)) {
    const value = values[field.key];
    if (blank(value)) continue;
    if (field.kind === 'hours') {
      const rows = value.filter((r) => r.days?.length && r.opens && r.closes);
      if (rows.length) node.openingHoursSpecification = rows.map((r) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: r.days.length === 1 ? r.days[0] : r.days, opens: r.opens, closes: r.closes }));
    } else if (field.kind === 'urls') {
      const list = (Array.isArray(value) ? value : String(value).split(/\s*\n\s*/)).map((v) => v.trim()).filter(Boolean);
      if (list.length) node[field.key] = list.length === 1 ? list[0] : list;
    } else if (field.kind === 'list') {
      const items = value.map((item, i) => {
        const out = {};
        if (type === 'BreadcrumbList') Object.assign(out, { '@type': 'ListItem', position: i + 1 });
        if (type === 'FAQPage') out['@type'] = 'Question';
        for (const sub of field.item) if (!blank(item[sub.key]) && !(type === 'BreadcrumbList' && sub.key === 'item' && i === value.length - 1)) setDeep(out, sub.key, item[sub.key]);
        return out;
      }).filter((item) => Object.keys(item).some((k) => !k.startsWith('@') && k !== 'position'));
      if (items.length) node[field.key] = items;
    } else if (field.kind === 'enum' && ['offers.availability', 'eventStatus'].includes(field.key)) {
      setDeep(node, field.key, `https://schema.org/${value}`);
    } else if (field.kind === 'price' || field.kind === 'coordinate') {
      setDeep(node, field.key, Number(String(value).replace(',', '.')));
    } else if (field.kind === 'boolean') {
      setDeep(node, field.key, value === true || value === 'true');
    } else {
      setDeep(node, field.key, typeof value === 'string' ? value.trim() : value);
    }
  }
  return node;
}

/* ------------------------------------------------------------- validation */

const FORMAT = {
  url: (v) => /^https?:\/\/[^\s/?#]+(\/\S*)?$/i.test(v),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  phone: (v) => /^\+\d[\d\s().-]{5,}$/.test(v),
  country: (v) => /^[A-Z]{2}$/.test(v),
  currency: (v) => /^[A-Z]{3}$/.test(v),
  date: (v) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(v),
  datetime: (v) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v),
  coordinate: (v) => /^-?\d{1,3}\.\d{5,}$/.test(String(v)),
  price: (v) => /^\d+([.,]\d+)?$/.test(String(v)),
  priceRange: (v) => String(v).length < 100,
};

const typesOf = (node) => [].concat(node?.['@type'] ?? []).map((t) => String(t).split(/[/:#]/).pop());

/**
 * Issues of one node, each `{ code, level, path, detail? }`. Levels: `error` (no Google result, or
 * meaningless markup), `warning` (a recommended field missing, a format Google rejects), `info`.
 * Codes are stable: callers translate them. Only the node's own type is judged; nested nodes with
 * their own `@type` are judged when the caller walks to them.
 */
export function validateNode(node) {
  const issues = [];
  const add = (code, level, path, detail) => issues.push(detail === undefined ? { code, level, path } : { code, level, path, detail });
  for (const type of typesOf(node)) {
    if (RETIRED_IN_GOOGLE[type]) add('retired_in_google', 'info', '@type', type);
    const entry = entryFor(type);
    if (!entry) continue;
    for (const field of fieldsFor(type)) {
      const value = field.kind === 'hours' ? node.openingHoursSpecification : getDeep(node, field.key);
      if (blank(value)) {
        if (field.level === 'required') add('required_missing', 'error', field.key);
        else if (field.level === 'recommended') add('recommended_missing', 'warning', field.key);
        continue;
      }
      if (field.kind === 'list') {
        const items = [].concat(value);
        items.forEach((item, i) => {
          for (const sub of field.item) {
            const last = i === items.length - 1;
            if (type === 'BreadcrumbList' && sub.key === 'item' && last) continue;
            const v = sub.key === 'name' && type === 'BreadcrumbList' ? (item.name ?? item.item?.name) : getDeep(item, sub.key);
            if (blank(v)) add('required_missing', 'error', `${field.key}[${i}].${sub.key}`);
          }
          if (type === 'BreadcrumbList' && item.position === undefined) add('required_missing', 'error', `${field.key}[${i}].position`);
        });
        continue;
      }
      const check = FORMAT[field.kind];
      const values = [].concat(value);
      if (check && values.some((v) => typeof v === 'object' ? false : !check(String(v).trim()))) add('format', 'warning', field.key, field.kind);
      if (field.kind === 'enum' && field.values && values.some((v) => !field.values.includes(String(v).split('/').pop()))) add('format', 'warning', field.key, 'enum');
    }
    if (entry.base === 'LocalBusiness' || entry.base === 'Organization') {
      if (node.aggregateRating || node.review) add('self_serving_review', 'error', node.aggregateRating ? 'aggregateRating' : 'review');
    }
    if (NOT_A_PLACE.has(type)) {
      for (const key of ['openingHoursSpecification', 'hasMap', 'geo']) if (node[key] !== undefined) add('not_for_type', 'warning', key, type);
    }
    if ((entry.base === 'WebApplication' || entry.base === 'SoftwareApplication') && !node.aggregateRating && !node.review) add('no_rating_no_result', 'info', 'aggregateRating');
  }
  return issues;
}

/**
 * The top-level nodes of a parsed JSON-LD value (a node, an array, or a `@graph`), each with its own
 * issues. Nested nodes (an author, an address, an offer) are judged through their parent's dotted
 * fields, not on their own: an author is not asked for a job title.
 */
export function validateJsonLd(value) {
  const out = [];
  const visit = (node, path) => {
    if (Array.isArray(node)) return node.forEach((n, i) => visit(n, `${path}[${i}]`));
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node['@graph'])) return node['@graph'].forEach((n, i) => visit(n, `${path}@graph[${i}]`));
    if (node['@type']) out.push({ path: path || '$', types: typesOf(node), issues: validateNode(node) });
  };
  visit(value, '');
  return out;
}
