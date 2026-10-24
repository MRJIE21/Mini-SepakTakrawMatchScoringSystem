"""New review writes require an explicit canonical event routing context."""
import json
import unittest
import urllib.error
import urllib.request
from app import db
import test_independent_review as fixtures


class ReviewContextTest(unittest.TestCase):
    def setUp(self):self.fixture=fixtures.IndependentReviewTest();self.fixture.setUp()
    def tearDown(self):self.fixture.tearDown()
    def bare(self,path,body,user='admin',headers=None):
        req=urllib.request.Request(self.fixture.base+path,method='POST',data=json.dumps(body).encode(),headers={
            'Content-Type':'application/json','Authorization':'Bearer '+self.fixture.tokens[user],
            'X-Client-Protocol':'3',**(headers or {})})
        try:
            with urllib.request.urlopen(req,timeout=10) as response:return response.status,json.loads(response.read())
        except urllib.error.HTTPError as error:
            try:return error.code,json.loads(error.read())
            finally:error.close()
    def test_grant_never_falls_back_to_the_registry_business_tables(self):
        body={'user_id':self.fixture.ids['reviewer'],'active':True,'base_version':0,'reason':'Explicit event test'}
        # 事件作用域路由缺 X-Event-ID 会先被服务器拒绝（missing_event_id）；只带部分身份时
        # 仍由复核权限层拒绝（event_context_required）。两者都证明不会回落到 registry 业务表。
        for headers, expected_code in (({}, 'missing_event_id'),
                                       ({'X-Event-ID': '1'}, 'event_context_required'),
                                       ({'X-Event-UUID': self.fixture.ident['event_uuid']}, 'missing_event_id')):
            status,data=self.bare('/api/events/1/review-grants',body,headers=headers)
            self.assertEqual(status,400,(headers,data))
            self.assertEqual(data['code'],expected_code,(headers,data))
        registry=db.connect()
        try:self.assertEqual(registry.execute('SELECT COUNT(*) FROM review_grants').fetchone()[0],0)
        finally:registry.close()
        self.assertEqual(db.q1(self.fixture.conn,'SELECT COUNT(*) FROM review_grants')[0],0)
    def test_all_candidate_mutations_reject_missing_event_context_before_lookup(self):
        received=self.fixture.receive();cid=received['candidate_id']
        for path,body in (('/api/result-candidates',self.fixture.packet()),
            (f'/api/result-candidates/{cid}/decision',self.fixture.decision(received)),
            (f'/api/result-candidates/{cid}/withdraw',self.fixture.decision(received,'withdraw')),
            (f'/api/result-candidates/{cid}/recuse',{'reason':'Explicit event test'})):
            status,data=self.bare(path,body)
            self.assertEqual(status,400,(path,data))
            self.assertEqual(data['code'],'missing_event_id',(path,data))
        self.assertEqual(db.q1(self.fixture.conn,'SELECT COUNT(*) FROM review_decisions')[0],0)


if __name__=='__main__':unittest.main()
