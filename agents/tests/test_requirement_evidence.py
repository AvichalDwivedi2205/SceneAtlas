from copy import deepcopy

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
