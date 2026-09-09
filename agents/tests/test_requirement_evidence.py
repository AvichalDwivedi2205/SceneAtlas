from copy import deepcopy

import pytest

from sceneatlas.research import attach_requirement_passage, normalize_sources

URL = 'https://www.parks.ca.gov/leocarrillo'
TITLE = 'Leo Carrillo State Park - California State Parks - CA.gov'
DETAIL = 'Commercial or student filming requires contacting the park film permit coordinator at (818) 880-0358.'


def fixture():
    evidence = {'searchId': 'actual-search', 'retrievedAt': 100, 'results': [{'url': URL, 'title': TITLE, 'excerpt': TITLE}]}
    requirement = {'title': 'Filming Permit', 'detail': DETAIL, 'status': 'sourced',
                   'sources': [{'url': URL}], 'formUrl': URL, 'attachments': ['Unverified application']}
    location = {'name': 'Leo Carrillo State Park', 'sources': [], 'costs': [], 'requirements': [requirement]}
    return {'locations': [location]}, evidence


def test_title_only_requirement_stays_unresolved_without_invented_guidance():
    result, evidence = fixture()
    req = normalize_sources(result, evidence)['locations'][0]['requirements'][0]
    assert req['status'] == 'unresolved'
    assert 'does not contain substantive guidance' in req['detail']
    assert req['attachments'] == [] and 'formUrl' not in req
    assert req['sources'][0]['excerpt'] == TITLE
    assert req['sources'][0]['searchId'] == 'actual-search'


def test_exact_extract_passage_replaces_title_and_keeps_actual_provenance():
    result, evidence = fixture()
    text = ('Campground and visitor information. ' * 180) + '\n' + DETAIL + '\nContact the authority before filming.'
    extracted = {'retrievedAt': 200, 'results': [{'url': URL, 'full_content': text}]}
    req = normalize_sources(result, evidence, extracted_evidence=extracted)['locations'][0]['requirements'][0]
    assert req['status'] == 'sourced'
    source = req['sources'][0]
    assert DETAIL in source['excerpt'] and source['excerpt'] in text
    assert len(source['excerpt']) <= 1600
    assert source['retrievedAt'] == 200 and source['searchId'] == 'actual-search'


def test_unrelated_extract_does_not_supply_requirement_text():
    result, evidence = fixture()
    extracted = {'retrievedAt': 200, 'results': [{'url': 'https://www.parks.ca.gov/another-park', 'full_content': DETAIL}]}
    req = normalize_sources(result, evidence, extracted_evidence=extracted)['locations'][0]['requirements'][0]
    assert req['status'] == 'unresolved'
    assert req['sources'][0]['retrievedAt'] == 100


def test_cached_passage_does_not_claim_fresh_extraction():
    source = {'url': URL, 'title': TITLE, 'excerpt': DETAIL, 'cached': True, 'retrievedAt': 100, 'searchId': 'original-search'}
    before = deepcopy(source)
    extracted = {'retrievedAt': 200, 'results': [{'url': URL, 'full_content': DETAIL + ' New material.'}]}
    assert attach_requirement_passage(source, {'title': 'Filming Permit', 'detail': DETAIL}, extracted)
    assert source == before


def test_small_crew_cannot_establish_simple_shoot_eligibility():
    result, evidence = fixture()
    req = result['locations'][0]['requirements'][0]
    req['detail'] = "This production qualifies as a 'Simple Shoot' because it has four crew and handheld equipment."
    evidence['results'][0]['excerpt'] = 'Simple Shoot categories depend on personnel, equipment, locations and activities. The authority confirms the category.'
    normalized = normalize_sources(result, evidence)['locations'][0]['requirements'][0]
    assert normalized['status'] == 'unresolved'
    assert 'authority must confirm' in normalized['detail']
    assert 'qualifies' not in normalized['detail']
    assert normalized['attachments'] == [] and 'formUrl' not in normalized


@pytest.mark.parametrize('excerpt', [
    'Student filming may use school liability insurance. A $50 review fee applies. The film permit coordinator confirms requirements.',
    'Insurance requires $1 million general liability coverage. Contact the film permit coordinator.',
    'Insurance requires $1 million general liability and $50,000 automobile liability coverage.',
])
def test_insurance_vocabulary_cannot_substantiate_missing_coverage_amounts(excerpt):
    result, evidence = fixture()
    result['locations'][0]['requirements'][0].update(title='Insurance Requirements',
        detail='Insurance requires $1 million general liability and $500,000 automobile liability coverage.')
    evidence['results'][0]['excerpt'] = excerpt
    req = normalize_sources(result, evidence)['locations'][0]['requirements'][0]
    assert req['status'] == 'unresolved'
    assert '$1 million' not in req['detail'] and '$500,000' not in req['detail']
    assert req['attachments'] == [] and 'formUrl' not in req


@pytest.mark.parametrize('detail', [
    'Insurance requires $1 million general liability and $500,000 automobile liability coverage.',
    'Insurance requires 1 million dollars general liability and 500000 USD automobile liability coverage.',
])
def test_matching_extract_preserves_exact_insurance_coverage_passage(detail):
    result, evidence = fixture()
    result['locations'][0]['requirements'][0].update(title='Insurance Requirements',
        detail=detail)
    text = 'Insurance requirements: USD 1,000,000 general liability and $500,000 automobile liability coverage. Confirm applicability with the authority.'
    extracted = {'retrievedAt': 200, 'results': [{'url': URL, 'full_content': text}]}
    req = normalize_sources(result, evidence, extracted_evidence=extracted)['locations'][0]['requirements'][0]
    assert req['status'] == 'sourced' and req['externalStatus'] == 'unverified'
    assert req['sources'][0]['excerpt'] == text
    assert req['sources'][0]['retrievedAt'] == 200


def test_unrelated_park_coverage_amounts_cannot_supply_insurance_evidence():
    result, evidence = fixture()
    detail = 'Insurance requires $1 million general liability and $500,000 automobile liability coverage.'
    result['locations'][0]['requirements'][0].update(title='Insurance Requirements', detail=detail)
    extracted = {'retrievedAt': 200, 'results': [{'url': 'https://www.parks.ca.gov/another-park', 'full_content': detail}]}
    req = normalize_sources(result, evidence, extracted_evidence=extracted)['locations'][0]['requirements'][0]
    assert req['status'] == 'unresolved' and req['sources'][0]['retrievedAt'] == 100


@pytest.mark.parametrize('address', [
    '7080 Hollywood Blvd., Suite 900, Hollywood, CA 90228',
    '7080 Hollywood Blvd., Suite 902, Hollywood, CA 90028',
])
def test_certificate_address_cannot_change_source_digits(address):
    result, evidence = fixture()
    result['locations'][0]['requirements'][0].update(title='Certificate of Insurance',
        detail=f'The certificate holder must be STATE OF CALIFORNIA at {address}.')
    evidence['results'][0]['excerpt'] = 'Certificate holder needs to read STATE OF CALIFORNIA with the CFC address (7080 Hollywood Blvd., Suite 900, Hollywood, CA 90028).'
    req = normalize_sources(result, evidence)['locations'][0]['requirements'][0]
    assert req['status'] == 'unresolved'
    assert address not in req['detail']
    assert req['sources'][0]['excerpt'] == evidence['results'][0]['excerpt']


def test_matching_certificate_address_keeps_exact_source_and_provenance():
    result, evidence = fixture()
    detail = 'Certificate holder must be STATE OF CALIFORNIA at 7080 Hollywood Blvd., Suite 900, Hollywood, CA 90028.'
    result['locations'][0]['requirements'][0].update(title='Certificate of Insurance', detail=detail)
    evidence['results'][0]['excerpt'] = detail
    req = normalize_sources(result, evidence)['locations'][0]['requirements'][0]
    assert req['status'] == 'sourced' and req['detail'] == detail
    assert req['sources'][0]['excerpt'] == detail


@pytest.mark.parametrize('phone,expected', [('8188800358', 'sourced'), ('+1 818-880-0358', 'sourced'), ('818-880-0359', 'unresolved')])
def test_requirement_phone_formatting_is_allowed_but_changed_digits_are_not(phone, expected):
    result, evidence = fixture()
    result['locations'][0]['requirements'][0]['detail'] = f'Commercial filming requires contacting the park film permit coordinator at {phone}.'
    evidence['results'][0]['excerpt'] = DETAIL
    req = normalize_sources(result, evidence)['locations'][0]['requirements'][0]
    assert req['status'] == expected
    assert req['sources'][0]['excerpt'] == DETAIL
