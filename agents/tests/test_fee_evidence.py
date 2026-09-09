import pytest

from sceneatlas.research import attach_fee_amount_evidence, fee_amount_match, normalize_sources


@pytest.mark.parametrize('text,amount', [
    ('Parking: $3 per hour.', 300), ('Application fee USD 100.00.', 10000),
    ('Fee: US$1,250.50 per day.', 125050), ('Rate: 100 USD.', 10000),
    ('Parking costs $3.5.', 350), ('No application fee.', 0),
])
def test_explicit_monetary_amounts(text, amount):
    assert fee_amount_match(text, amount)


@pytest.mark.parametrize('text,amount', [
    ('Call 310-555-0300 on 3/3/2026.', 300), ('$300 per day.', 300),
    ('$3.50 per hour.', 300), ('$3,000 per day.', 300),
    ('Fees require confirmation.', 0), ('$100.05 application fee.', 10000),
])
def test_unrelated_numbers_are_not_fee_evidence(text, amount):
    assert fee_amount_match(text, amount) is None


def normalize_cost(excerpt, *, coverage='', approved=False, extracted=None):
    url = 'https://film.ca.gov/state-permits/state-parks-beaches/'
    evidence = {'searchId': 'observed-search', 'retrievedAt': 100,
                'results': [{'url': url, 'title': 'State park filming', 'excerpt': excerpt}]}
    cost = {'basis': 'published', 'amountMinor': 10000, 'currency': 'USD',
            'assumptions': '', 'coverageReason': coverage, 'source': {'url': url}}
    result = normalize_sources({'locations': [{'costs': [cost]}]}, evidence,
                               allow_fee_estimates=approved, extracted_evidence=extracted)
    return result['locations'][0]['costs'][0]


@pytest.mark.parametrize('coverage', [
    'Assumes one day of filming.', 'Duration rounded up to one day.',
])
def test_hidden_quantity_assumptions_require_estimate_consent(coverage):
    cost = normalize_cost('Application fee: $100.', coverage=coverage)
    assert (cost['basis'], cost['amountMinor']) == ('unknown', None)
    approved = normalize_cost('Application fee: $100.', coverage=coverage, approved=True)
    assert (approved['basis'], approved['amountMinor']) == ('estimate', 10000)


def test_untraceable_published_rate_stays_unknown():
    cost = normalize_cost('Contact the district for current fees.')
    assert (cost['basis'], cost['amountMinor']) == ('unknown', None)
    assert 'does not establish this fee amount' in cost['assumptions']


def test_published_rate_requires_a_matching_provider_passage():
    cost = normalize_cost('Application fee: USD 100.00 per application.')
    assert (cost['basis'], cost['amountMinor']) == ('published', 10000)
    assert cost['source']['searchId'] == 'observed-search'


def test_extract_attaches_exact_fee_passage_with_actual_retrieval_time():
    text = 'Official guidance. ' * 100 + 'Application fee: $100 per application. Contact the district.'
    extracted = {'retrievedAt': 200, 'results': [{
        'url': 'https://film.ca.gov/state-permits/state-parks-beaches/',
        'full_content': text,
    }]}
    cost = normalize_cost('Contact the district for fees.', extracted=extracted)
    assert cost['basis'] == 'published'
    source = cost['source']
    assert source['excerpt'] in text and '$100' in source['excerpt']
    assert len(source['excerpt']) <= 700
    assert source['retrievedAt'] == 200
    assert source['searchId'] == 'observed-search'


@pytest.mark.parametrize('cached,extract_url', [(True, 'https://example.com/fees'), (False, 'https://example.com/other')])
def test_unrelated_or_fresh_extract_cannot_rewrite_cached_fee_provenance(cached, extract_url):
    cost = {'amountMinor': 10000, 'currency': 'USD', 'source': {
        'url': 'https://example.com/fees', 'excerpt': 'Contact for fees.', 'cached': cached,
        'retrievedAt': 100, 'searchId': 'saved-search'}}
    extracted = {'retrievedAt': 200, 'results': [{'url': extract_url, 'excerpts': ['Fee: $100.']}]}
    assert not attach_fee_amount_evidence(cost, extracted)
    assert cost['source']['retrievedAt'] == 100


@pytest.mark.parametrize('approved', [False, True])
@pytest.mark.parametrize('coverage,excerpt', [
    ("This production qualifies as a Simple Shoot.", 'Review fee: $100.'),
    ('Review fee for filming.', 'Simple Shoot review fee: $100. Complex Shoot review fee: $250.'),
])
def test_category_specific_rates_need_confirmed_eligibility_or_estimate_consent(approved, coverage, excerpt):
    cost = normalize_cost(excerpt, coverage=coverage, approved=approved)
    assert cost['basis'] == ('estimate' if approved else 'unknown')
    assert cost['amountMinor'] == (10000 if approved else None)
    assert 'confirm' in cost['assumptions'].lower()


@pytest.mark.parametrize('unit', ['hour', 'hourly', 'per hour', 'hr'])
@pytest.mark.parametrize('approved', [False, True])
def test_published_hourly_rate_is_not_a_confirmed_full_plan_quantity(unit, approved):
    url = 'https://film.ca.gov/state-permits/state-parks-beaches/'
    evidence = {'searchId': 'actual-search', 'retrievedAt': 100, 'results': [
        {'url': url, 'title': 'State park filming', 'excerpt': 'Parking rate: $3 per hour. Confirm billable duration.'}]}
    cost = {'id': 'parking', 'label': 'Hourly parking', 'unit': unit, 'quantity': 1,
            'basis': 'published', 'amountMinor': 300, 'currency': 'USD', 'assumptions': '',
            'coverageReason': 'One passenger car for 45-minute scene, 1-hour minimum parking fee.', 'source': {'url': url}}
    normalized = normalize_sources({'locations': [{'costs': [cost]}]}, evidence,
                                   allow_fee_estimates=approved)['locations'][0]['costs'][0]
    assert normalized['basis'] == ('estimate' if approved else 'unknown')
    assert normalized['amountMinor'] == (300 if approved else None)
    assert 'complete plan remain unconfirmed' in normalized['coverageReason']
    assert '45-minute' not in normalized['coverageReason']
    assert '$3 per hour' in normalized['source']['excerpt']
    assert normalized['source']['searchId'] == 'actual-search'


@pytest.mark.parametrize('basis', ['published', 'quote', 'estimate', 'unknown'])
@pytest.mark.parametrize('claim', [
    'Production qualifies as a Simple Shoot (max 14 personnel, handheld equipment).',
    'Production qualifies for the fees for simple shoots because the crew is small.',
])
def test_category_claim_is_removed_even_after_amount_is_unknown(basis, claim):
    url = 'https://film.ca.gov/state-permits/state-parks-beaches/'
    evidence = {'searchId': 'actual-search', 'retrievedAt': 100, 'results': [
        {'url': url, 'title': 'State park filming', 'excerpt': 'Permit review fee: $100. The authority determines classification.'}]}
    cost = {'label': 'Filming Permit Review Fee', 'basis': basis,
            'amountMinor': None if basis == 'unknown' else 10000, 'currency': 'USD',
            'unit': 'day', 'quantity': 1, 'assumptions': '', 'source': {'url': url},
            'coverageReason': claim}
    normalized = normalize_sources({'locations': [{'costs': [cost]}]}, evidence)['locations'][0]['costs'][0]
    assert normalized['basis'] == 'unknown' and normalized['amountMinor'] is None
    assert 'qualifies' not in normalized['coverageReason']
    assert 'authority must confirm' in normalized['coverageReason'].lower()
    assert 'alone do not establish' in normalized['coverageReason']
