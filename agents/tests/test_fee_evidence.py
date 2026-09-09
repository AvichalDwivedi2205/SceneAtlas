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
