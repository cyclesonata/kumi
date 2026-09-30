import hashlib
import unittest
from test_remote_script import FakeSong, FakeClip
from ableton_mcp_remote_script import LiveObjectMapper, validate_operation_payload

class FollowClip(FakeClip):
    def __init__(self):
        super().__init__(4)
        self.is_playing = self.is_triggered = self.is_recording = False
        self.follow_action_enabled = False
        self.follow_action_linked = True
        self.follow_action_a = 4
        self.follow_action_b = 0
        self.follow_action_loop_count = 1
        self.follow_action_time = 4.0
        self.follow_action_jump_a = self.follow_action_jump_b = 1.0
        self.follow_action_chance_a = 100
    @property
    def follow_action_chance_a(self): return self._chance
    @follow_action_chance_a.setter
    def follow_action_chance_a(self, value): self._chance = float(value)
    @property
    def follow_action_chance_b(self): return 100 - self._chance

class WillingtonTests(unittest.TestCase):
    def setUp(self):
        self.song = FakeSong(); self.clip = FollowClip()
        self.song.tracks[0].clip_slots[0].clip = self.clip
        self.mapper = LiveObjectMapper(self.song)
        self.mapper.willington_follow_writes = True
        self.row = self.mapper.snapshot()['tracks'][0]['clips'][0]
    def args(self, **changes):
        before = self.mapper._follow_action_fields(self.clip)
        return {**before, **changes, 'ref': self.row['ref'], 'expectedObjectIdentity': self.row['objectIdentity'],
                'expectedAuthorityRevision': self.mapper._clip_authority_digest(self.row['ref']),
                'expectedStateRevision': hashlib.sha256(self.mapper._bounded_canonical(before).encode()).hexdigest()}
    def test_follow_read_write_and_explicit_restoration(self):
        self.assertTrue(self.mapper._operation_supported('clip.follow-actions.set'))
        prior = self.mapper._follow_action_fields(self.clip)
        args = self.args(followActionChanceA=75, followActionChanceB=25, followActionEnabled=True)
        validate_operation_payload('clip.follow-actions.set', 'request', args)
        result = self.mapper.invoke('clip.follow-actions.set', args)
        validate_operation_payload('clip.follow-actions.set', 'result', result)
        self.assertEqual(self.clip.follow_action_chance_b, 25)
        self.mapper.invoke('clip.follow-actions.set', self.args(**prior))
        self.assertEqual(self.mapper._follow_action_fields(self.clip), prior)
    def test_refuse_disabled_stale_playing_and_invalid(self):
        self.mapper.willington_follow_writes = False
        self.assertFalse(self.mapper._operation_supported('clip.follow-actions.set'))
        with self.assertRaises(ValueError): self.mapper._follow_action_set(self.args())
        self.mapper.willington_follow_writes = True
        stale = self.args(); self.clip.follow_action_a = 5
        with self.assertRaisesRegex(ValueError, 'state changed'): self.mapper._follow_action_set(stale)
        for values in ({'followActionChanceA': 75}, {'followActionA': True}, {'followActionJumpA': 0}, {'followActionLoopCount': 1.5}):
            with self.assertRaises(ValueError): self.mapper._follow_action_set(self.args(**values))
        self.song.is_playing = True
        with self.assertRaisesRegex(ValueError, 'stopped'): self.mapper._follow_action_set(self.args())
    def test_partial_write_restores_all_fields(self):
        prior = self.mapper._follow_action_fields(self.clip)
        original = self.clip.__class__
        class FailingClip(original):
            fail = True
            def __setattr__(self, key, value):
                if key == 'follow_action_loop_count' and value == 2 and self.fail:
                    self.fail = False
                    raise RuntimeError('injected')
                super().__setattr__(key, value)
        self.clip.__class__ = FailingClip
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            self.mapper._follow_action_set(self.args(followActionA=7, followActionLoopCount=2))
        self.assertEqual(self.mapper._follow_action_fields(self.clip), prior)

class DeviceTests(unittest.TestCase):
    def setUp(self):
        import json
        from test_remote_script import FakeRackDevice, FakeDevice
        self.song = FakeSong(); self.rack = FakeRackDevice(); self.target = FakeDevice()
        self.rack.chains = [type('Chain', (), {'name':'Chain', 'devices':[self.target], 'mute':False, 'solo':False})()]
        self.song.tracks[0].devices = [self.rack]
        self.mapper = LiveObjectMapper(self.song); self.mapper.willington_device_writes = True
        self.mapping = None; self.name = 'Variation 1'
        self.rack.rename_macro = lambda index, name: setattr(self.rack.macros[index], 'name', name)
        self.rack.get_selected_variation_name = lambda: self.name
        self.rack.rename_selected_variation = lambda name: setattr(self, 'name', name)
        self.rack.get_macro_mapping = lambda target: json.dumps(self.mapping)
        self.rack.map_macro = lambda index, target: setattr(self, 'mapping', {'index':index,'minimum':0.,'maximum':1.,'kind':'continuous'})
        self.rack.set_macro_mapping_range = lambda target, low, high: self.mapping.update(minimum=low,maximum=high)
        self.rack.unmap_macro = lambda target: setattr(self, 'mapping', None)
        self.row = self.mapper.snapshot()['tracks'][0]['devices'][0]
        self.ref = self.row['ref']; self.target_ref = self.row['chains'][0]['devices'][0]['parameters'][0]['ref']
    def selector(self, kind):
        return {'ref':self.ref,'kind':kind, **({'macroIndex':0} if kind=='macro-name' else {'targetRef':self.target_ref} if kind=='macro-mapping' else {})}
    def apply(self, kind, next):
        selector = self.selector(kind)
        before = self.mapper.invoke('willington.device.read', selector)
        args = {**selector,'next':next,'expectedStateRevision':before['stateRevision']}
        validate_operation_payload('willington.device.set','request',args)
        result = self.mapper.invoke('willington.device.set',args)
        validate_operation_payload('willington.device.set','result',result)
        return before,result
    def test_names_apply_and_restore(self):
        for kind in ['macro-name','variation-name']:
            before,after = self.apply(kind, {'name':'Kumi 測試'})
            self.assertEqual(after['state']['name'],'Kumi 測試')
            _, restored = self.apply(kind, {'name':before['state']['name']})
            self.assertEqual(restored['stateRevision'],before['stateRevision'])
    def test_mapping_apply_and_restore(self):
        before,after = self.apply('macro-mapping', {'mapping':{'index':0,'minimum':0.75,'maximum':0.25,'kind':'continuous'},'parameterValue':0.5})
        self.assertEqual(self.mapping['minimum'],0.75)
        _,restored = self.apply('macro-mapping', {'mapping':None,'parameterValue':before['state']['parameterValue']})
        self.assertEqual(restored['stateRevision'], before['stateRevision'])
    def test_mapping_failure_compensates(self):
        self.rack.set_macro_mapping_range = lambda *args: (_ for _ in ()).throw(RuntimeError('injected'))
        with self.assertRaisesRegex(RuntimeError,'injected'):
            self.apply('macro-mapping', {'mapping':{'index':0,'minimum':0.75,'maximum':0.25,'kind':'continuous'},'parameterValue':0.5})
        self.assertIsNone(self.mapping)
    def test_stale_detached_invalid_and_playing(self):
        selector = self.selector('macro-name'); before = self.mapper.invoke('willington.device.read',selector)
        self.rack.macros[0].name = 'External edit'
        with self.assertRaisesRegex(ValueError,'changed'):
            self.mapper.invoke('willington.device.set',{**selector,'next':{'name':'New'},'expectedStateRevision':before['stateRevision']})
        with self.assertRaisesRegex(ValueError,'selector'):
            self.mapper.invoke('willington.device.read',{**selector,'targetRef':self.target_ref})
        self.song.is_playing = True
        with self.assertRaisesRegex(ValueError,'stopped'): self.apply('macro-name', {'name':'New'})
        self.song.is_playing = False; self.rack.chains[0].devices = []
        with self.assertRaisesRegex(ValueError,'no longer'): self.apply('macro-mapping',{'mapping':None,'parameterValue':0.5})

class ProviderTests(unittest.TestCase):
    def test_absent_invalid_and_duplicate_owner_fail_closed(self):
        import tempfile, json, types
        from pathlib import Path
        from unittest.mock import patch
        import AbletonMcpBridge as wrapper
        with tempfile.TemporaryDirectory() as folder:
            mapper=types.SimpleNamespace(); logs=[]; live=types.SimpleNamespace(_kumi_willington_owner=object())
            with patch.object(wrapper,'__file__',str(Path(folder)/'__init__.py')), patch.dict('sys.modules',{'Live':live}):
                wrapper._WillingtonProvider(mapper,logs.append)
                self.assertFalse(mapper.willington_follow_writes)
                path=Path(folder)/'willington.json';path.write_text('{}');path.chmod(0o600)
                wrapper._WillingtonProvider(mapper,logs.append)
                self.assertFalse(mapper.willington_device_writes)
                path.write_text(json.dumps({'version':1,'followActions':False,'deviceTools':False,'enableWrites':False}))
                owner=live._kumi_willington_owner
                wrapper._WillingtonProvider(mapper,logs.append)
                self.assertIs(live._kumi_willington_owner,owner)
                self.assertEqual(len(logs),2)
    def test_device_owner_enable_and_teardown(self):
        import tempfile,json,types
        from pathlib import Path
        from unittest.mock import patch
        import AbletonMcpBridge as wrapper
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'willington.json';path.write_text(json.dumps({'version':1,'followActions':False,'deviceTools':True,'enableWrites':True}));path.chmod(0o600)
            calls=[];native=types.SimpleNamespace(enable=lambda enabled:calls.append(enabled),uninstall=lambda:calls.append('uninstall'))
            live=types.SimpleNamespace();mapper=types.SimpleNamespace()
            with patch.object(wrapper,'__file__',str(path.with_name('__init__.py'))),patch.dict('sys.modules',{'Live':live,'WillingtonDeviceTools':types.ModuleType('WillingtonDeviceTools'),'WillingtonDeviceTools.api':types.SimpleNamespace(install=lambda:native)}):
                provider=wrapper._WillingtonProvider(mapper,None)
                self.assertTrue(mapper.willington_device_writes)
                self.assertIs(live._kumi_willington_owner,provider)
                provider.close();provider.close()
                self.assertEqual(calls,[True,'uninstall'])
                self.assertFalse(mapper.willington_device_writes)
                self.assertIsNone(live._kumi_willington_owner)
