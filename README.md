# Shortlist Bid: live tender data

Open UK public-sector tenders for cleaning and facilities, security, care and support, and charity and community services, refreshed daily from [Find a Tender](https://www.find-tender.service.gov.uk/). Used by [shortlistbid.co.uk/tenders](https://shortlistbid.co.uk/tenders).

- `fetch-tenders.mjs` fetches and filters the notices and writes `tenders.json`.
- `.github/workflows/update-tenders.yml` runs it every day at 05:20 UTC. Run it by hand from the Actions tab.

Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
